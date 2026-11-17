import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth";

export interface TestKey {
  privateKey: string;
  txt: string;
}

export function makeKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    txt: `v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`
  };
}

export function rawMessage(from: string, body = "hello\r\n"): string {
  return [`From: ${from}`, "To: agent-test@inbound-mailtrap.io", "Subject: Hello", "Message-ID: <synthetic-raw@mail.example.test>", "Date: Mon, 09 Nov 2026 10:00:00 +0000", "", body].join("\r\n");
}

/** Signs a synthetic message. `domain`/`selector` are the d= and s= of the signature. */
export async function sign(raw: string, key: TestKey, domain: string, selector = "s1"): Promise<Buffer> {
  const res = await dkimSign(raw, { signatureData: [{ signingDomain: domain, selector, privateKey: key.privateKey, algorithm: "rsa-sha256" }] });
  if (res.errors.length) throw new Error(String(res.errors[0]?.err));
  return Buffer.from(res.signatures + raw);
}

/** A mocked DNS resolver: `${selector}._domainkey.${domain}` -> TXT. Everything else is NXDOMAIN. */
export function mockResolver(records: Record<string, string>) {
  const lookups: string[] = [];
  const resolver = async (name: string, rr: string) => {
    lookups.push(`${rr} ${name}`);
    const txt = records[name];
    if (rr === "TXT" && txt) return [[txt]];
    throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  };
  return Object.assign(resolver, { lookups });
}
