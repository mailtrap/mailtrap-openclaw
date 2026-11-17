import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("reply-only guarantee", () => {
  it("the channel source never calls replyAll, forward, the Sending API or message delete", () => {
    for (const f of files("src").filter((x) => x.endsWith(".ts"))) {
      const text = read(f);
      expect(text, f).not.toMatch(/replyAll|\.forward\(|\.send\(|messages\.delete|threads\.delete|\.batch\(/);
    }
  });

  it("only reply is exposed by the Inbound adapter", () => {
    const api = read("src/mailtrap-api.ts");
    expect(api.match(/inbound\.messages\.(\w+)/g)?.sort()).toEqual(["inbound.messages.get", "inbound.messages.getList", "inbound.messages.reply"]);
  });
});

describe("no personal data from the live fixtures", () => {
  // The check is structural: it stores nothing derived from real data (no names, no hashes).
  // Every email address in the repo must sit on a reserved or placeholder domain, and no
  // raw message files or consumer-mailbox domains may appear.
  const ALLOWED_DOMAIN = /(^|\.)(test|invalid|example|example\.com|example\.org|yourdomain\.com|inbound-mailtrap\.io|mailtrap\.io)$/;
  const generic = [/gmail\.com/i, /\.eml\b/];
  const foreignAddresses = (text: string): string[] =>
    [...text.matchAll(/[\p{L}\p{N}._%+-]+@([\p{L}\p{N}.-]+\.[\p{L}]{2,})/gu)].map((m) => m[1]!.toLowerCase()).filter((d) => !ALLOWED_DOMAIN.test(d));
  it("every address in the repo is on a reserved or placeholder domain", () => {
    const targets = [...files("test"), ...files("src"), "README.md", "package.json", "openclaw.plugin.json"];
    for (const f of targets) {
      const text = read(f);
      if (f !== join("test", "audit.test.ts")) {
        expect(foreignAddresses(text), `${f} has an address on a real domain`).toEqual([]);
        for (const re of generic) expect(text, `${f} matches ${re}`).not.toMatch(re);
      }
    }
  });
  it("the matcher flags real-looking domains and accepts reserved ones", () => {
    expect(foreignAddresses("a@" + "realcorp.org")).toEqual(["realcorp.org"]);
    expect(foreignAddresses("a@example.test b@mail.example.test c@inbound-mailtrap.io d@example.com")).toEqual([]);
  });
});
