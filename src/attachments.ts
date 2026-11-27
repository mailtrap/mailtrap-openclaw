import { realpath, readFile, stat } from "node:fs/promises";
import { basename, relative, isAbsolute, sep } from "node:path";
import type { InboundApi, InboundAttachment, InboundMessage, ReplyAttachment } from "./types.js";
import type { PendingReply } from "./ledger.js";

export interface SavedFile {
  path: string;
  contentType?: string;
}

export interface InboundMedia {
  path: string;
  filename: string;
  contentType?: string;
}

export interface InboundAttachmentDeps {
  api: InboundApi;
  inboxId: number;
  maxBytes: number;
  /** Downloads a URL; must throw `{statusCode}` on HTTP errors and refuse bodies over maxBytes. */
  download: (url: string, maxBytes: number) => Promise<Buffer>;
  /** Stores bytes in OpenClaw's media store. */
  save: (buf: Buffer, info: { filename: string; contentType?: string; maxBytes: number }) => Promise<SavedFile>;
  now?: () => number;
}

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
/** Deadline for one attachment download, body included, so a stalled server can't block the drain. */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/** https-only download with a deadline and a hard byte cap, streamed so an oversize body is never buffered whole. */
export async function defaultDownload(url: string, maxBytes: number): Promise<Buffer> {
  if (!url.startsWith("https://")) throw new Error("attachment URL is not https");
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error(`download failed: ${res.status}`), { statusCode: res.status });
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw Object.assign(new Error("too large"), { tooLarge: true });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error("too large"), { tooLarge: true });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Inbound attachments: download straight away into OpenClaw's
 * media store. An expired URL (by timestamp, or refused with 403/404/410) is
 * replaced by re-getting the message once. Files over the limit are skipped,
 * but a note tells the agent they existed.
 */
export async function fetchAttachments(msg: InboundMessage, d: InboundAttachmentDeps): Promise<{ media: InboundMedia[]; notes: string[] }> {
  const media: InboundMedia[] = [];
  const notes: string[] = [];
  let fresh: InboundMessage | undefined;
  const refreshed = async (a: InboundAttachment): Promise<InboundAttachment | undefined> => {
    fresh ??= await d.api.getMessage(d.inboxId, msg.id);
    return fresh.attachments.find((x) => x.attachment_id === a.attachment_id);
  };
  const now = d.now ?? Date.now;

  for (const a of msg.attachments) {
    const filename = basename(a.filename || `attachment-${a.attachment_id}`);
    if (a.size !== null && a.size > d.maxBytes) {
      notes.push(`Attachment "${filename}" (${mb(a.size)}) was not downloaded: it is over the ${mb(d.maxBytes)} limit.`);
      continue;
    }
    try {
      let cur: InboundAttachment | undefined = a;
      if (!cur.download_url || (cur.download_url_expires_at && Date.parse(cur.download_url_expires_at) - now() < 60_000)) cur = await refreshed(a);
      if (!cur?.download_url) throw new Error("no download URL");
      let buf: Buffer;
      try {
        buf = await d.download(cur.download_url, d.maxBytes);
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code !== 403 && code !== 404 && code !== 410) throw err;
        const again = await refreshed(a);
        if (!again?.download_url) throw err;
        buf = await d.download(again.download_url, d.maxBytes);
      }
      const contentType = a.content_type ?? undefined;
      const saved = await d.save(buf, { filename, contentType, maxBytes: d.maxBytes });
      media.push({ path: saved.path, filename, contentType: saved.contentType ?? contentType });
    } catch (err) {
      const tooLarge = (err as { tooLarge?: boolean }).tooLarge;
      notes.push(
        tooLarge
          ? `Attachment "${filename}" was not downloaded: it is over the ${mb(d.maxBytes)} limit.`
          : `Attachment "${filename}" could not be downloaded.`
      );
    }
  }
  return { media, notes };
}

export interface OutboundDeps {
  /** Directories that hold OpenClaw's own media output. Nothing outside them is ever attached. */
  roots: string[];
  maxBytes: number;
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/** OpenClaw's media store saves a file as `<name>---<uuid>.<ext>`; the recipient should see `<name>.<ext>`. */
export function cleanMediaFilename(name: string): string {
  const clean = name.replace(/---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.[^./\\]*$|$)/i, "");
  return clean && clean !== "." ? clean : name;
}

const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain", log: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  html: "text/html", htm: "text/html", xml: "application/xml", json: "application/json", yaml: "application/yaml", yml: "application/yaml",
  ics: "text/calendar", pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

/** Content type from the file extension; `application/octet-stream` only when the extension is unknown. */
export function contentTypeFromFilename(name: string): string {
  const ext = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase();
  return (ext && CONTENT_TYPES[ext]) || "application/octet-stream";
}

/**
 * Outbound attachments: only files that resolve (symlinks
 * followed) into OpenClaw's media directory, never arbitrary local paths, and
 * capped per file. Anything else is left off and named in the returned notes.
 */
export async function loadOutboundAttachments(media: PendingReply["media"], d: OutboundDeps): Promise<{ attachments: ReplyAttachment[]; notes: string[] }> {
  const attachments: ReplyAttachment[] = [];
  const notes: string[] = [];
  const roots = await Promise.all(d.roots.map((r) => realpath(r).catch(() => r)));
  const seen = new Set<string>();
  for (const m of media) {
    const name = cleanMediaFilename(basename(m.filename || m.path));
    try {
      if (!isAbsolute(m.path)) throw new Error("not a local media path");
      const real = await realpath(m.path);
      if (!roots.some((r) => inside(r, real))) throw new Error("outside the media directory");
      // The same file can arrive twice (mediaUrls and mediaUrl, or a link to it): attach it once.
      if (seen.has(real)) continue;
      seen.add(real);
      const info = await stat(real);
      if (!info.isFile()) throw new Error("not a file");
      if (info.size > d.maxBytes) {
        notes.push(`Attachment "${name}" (${mb(info.size)}) was not sent: it is over the ${mb(d.maxBytes)} limit.`);
        continue;
      }
      attachments.push({ content: (await readFile(real)).toString("base64"), filename: name, type: m.type && m.type !== "application/octet-stream" ? m.type : contentTypeFromFilename(name), disposition: "attachment" });
    } catch {
      notes.push(`Attachment "${name}" was not sent.`);
    }
  }
  return { attachments, notes };
}
