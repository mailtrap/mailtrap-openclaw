export interface ParsedAddress {
  email: string;
  name: string | undefined;
}

/** "Alex <a@b.test>" or "a@b.test" -> { email: "a@b.test", name }. Returns undefined when no address is found. */
export function parseAddress(raw: string | null | undefined): ParsedAddress | undefined {
  if (!raw) return undefined;
  const angle = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(raw.trim());
  const email = (angle ? angle[2]! : raw.trim()).toLowerCase();
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(email)) return undefined;
  const name = angle ? angle[1]!.trim().replace(/^"|"$/g, "") : "";
  return { email, name: name || undefined };
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/** Default deny. Entries are exact addresses or `@domain` (exactly that domain, not its subdomains). */
export function isAllowed(email: string, allowFrom: readonly string[]): boolean {
  const e = email.toLowerCase();
  const d = `@${domainOf(e)}`;
  return allowFrom.some((entry) => entry === e || (entry.startsWith("@") && entry === d));
}
