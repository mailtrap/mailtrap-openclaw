import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanMediaFilename, contentTypeFromFilename, loadOutboundAttachments } from "../src/attachments.js";
import { pollOnce } from "../src/poller.js";
import { makeHarness } from "./helpers/harness.js";
import { makeMessage } from "./helpers/memory.js";

const att = (over: Record<string, unknown> = {}) => ({ attachment_id: "a1", size: 10, filename: "notes.txt", content_type: "text/plain", content_disposition: "attachment" as const, content_id: null, download_url: "https://files.example.test/a1", download_url_expires_at: "2099-01-01T00:00:00.000Z", ...over });

function inboundHarness(download: (url: string, max: number) => Promise<Buffer>, maxBytes = 1000) {
  const saved: Array<{ filename: string; size: number }> = [];
  const h = makeHarness({
    inbound: { maxBytes, download, save: async (buf, info) => (saved.push({ filename: info.filename, size: buf.length }), { path: `/media/${info.filename}`, contentType: info.contentType }) }
  });
  return { h, saved };
}

async function receive(h: ReturnType<typeof makeHarness>, over: Record<string, unknown>) {
  await pollOnce(h.api, 1001, h.ledger);
  const m = h.api.add(makeMessage(over));
  await pollOnce(h.api, 1001, h.ledger);
  await h.runtime.drain();
  return m;
}

describe("inbound attachments", () => {
  it("downloads into media and hands the paths to the agent", async () => {
    const { h, saved } = inboundHarness(async () => Buffer.from("hello file"));
    await receive(h, { attachments: [att()] });
    expect(saved).toEqual([{ filename: "notes.txt", size: 10 }]);
    expect(h.turns[0]!.media).toEqual([{ path: "/media/notes.txt", filename: "notes.txt", contentType: "text/plain" }]);
  });

  it("skips an oversize file by declared size but tells the agent it existed", async () => {
    let downloads = 0;
    const { h, saved } = inboundHarness(async () => (downloads++, Buffer.from("x")), 1024 * 1024);
    await receive(h, { attachments: [att({ size: 5 * 1024 * 1024, filename: "big.zip" })] });
    expect(downloads).toBe(0);
    expect(saved).toHaveLength(0);
    expect(h.turns[0]!.body).toContain('Attachment "big.zip" (5.0 MB) was not downloaded');
    expect(h.api.replies).toHaveLength(1); // the message is still answered
  });

  it("skips a file that turns out oversize mid-download", async () => {
    const { h } = inboundHarness(async () => {
      throw Object.assign(new Error("too large"), { tooLarge: true });
    });
    await receive(h, { attachments: [att({ size: null })] });
    expect(h.turns[0]!.body).toContain("over the");
    expect(h.turns[0]!.media).toEqual([]);
  });

  it("re-gets the message for a fresh URL when the download URL has expired (403)", async () => {
    const urls: string[] = [];
    const { h, saved } = inboundHarness(async (url) => {
      urls.push(url);
      if (url.endsWith("/stale")) throw Object.assign(new Error("expired"), { statusCode: 403 });
      return Buffer.from("data");
    });
    const m = await (async () => {
      await pollOnce(h.api, 1001, h.ledger);
      const msg = h.api.add(makeMessage({ attachments: [att({ download_url: "https://files.example.test/stale" })] }));
      let gets = 0;
      h.api.getMessageImpl = async () => (gets++ === 0 ? msg : { ...msg, attachments: [att({ download_url: "https://files.example.test/fresh" })] });
      await pollOnce(h.api, 1001, h.ledger);
      await h.runtime.drain();
      return msg;
    })();
    expect(urls).toEqual(["https://files.example.test/stale", "https://files.example.test/fresh"]);
    expect(saved).toHaveLength(1);
    expect((await h.ledger.get(m.id))?.state).toBe("done");
  });

  it("refreshes an attachment whose URL is already past its expiry without trying it", async () => {
    const urls: string[] = [];
    const { h } = inboundHarness(async (url) => (urls.push(url), Buffer.from("d")));
    await pollOnce(h.api, 1001, h.ledger);
    const msg = h.api.add(makeMessage({ attachments: [att({ download_url: "https://files.example.test/old", download_url_expires_at: "2000-01-01T00:00:00.000Z" })] }));
    h.api.getMessageImpl = async () => ({ ...msg, attachments: [att({ download_url: "https://files.example.test/new" })] });
    await pollOnce(h.api, 1001, h.ledger);
    await h.runtime.drain();
    expect(urls).toEqual(["https://files.example.test/new"]);
  });

  it("notes a download that still fails after the refresh, and still replies", async () => {
    const { h } = inboundHarness(async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    });
    await receive(h, { attachments: [att()] });
    expect(h.turns[0]!.body).toContain('Attachment "notes.txt" could not be downloaded');
    expect(h.api.replies).toHaveLength(1);
  });

  it("strips directories from hostile filenames", async () => {
    const { h, saved } = inboundHarness(async () => Buffer.from("d"));
    await receive(h, { attachments: [att({ filename: "../../etc/passwd" })] });
    expect(saved[0]!.filename).toBe("passwd");
  });
});

describe("outbound attachments", () => {
  function dirs() {
    const base = mkdtempSync(join(tmpdir(), "mt-att-"));
    const media = join(base, "media");
    mkdirSync(media);
    return { base, media };
  }

  it("attaches only files inside OpenClaw's media directory, as base64", async () => {
    const { media } = dirs();
    writeFileSync(join(media, "report.pdf"), "PDFDATA");
    const r = await loadOutboundAttachments([{ path: join(media, "report.pdf"), filename: "report.pdf", type: "application/pdf" }], { roots: [media], maxBytes: 1000 });
    expect(r.notes).toEqual([]);
    expect(r.attachments).toEqual([{ content: Buffer.from("PDFDATA").toString("base64"), filename: "report.pdf", type: "application/pdf", disposition: "attachment" }]);
  });

  it("sends a file once, under its clean name and a content type from the extension", async () => {
    const { media } = dirs();
    const stored = join(media, "summary---0b9e8c3e-6f1d-4c52-9a7e-1d2f3a4b5c6d.txt");
    writeFileSync(stored, "SUMMARY");
    // the same stored file arrives from both mediaUrls and mediaUrl
    const item = { path: stored, filename: "summary---0b9e8c3e-6f1d-4c52-9a7e-1d2f3a4b5c6d.txt" };
    const r = await loadOutboundAttachments([item, { ...item }], { roots: [media], maxBytes: 1000 });
    expect(r.notes).toEqual([]);
    expect(r.attachments).toEqual([{ content: Buffer.from("SUMMARY").toString("base64"), filename: "summary.txt", type: "text/plain", disposition: "attachment" }]);
  });

  it("attaches one file once even when it is reached through two paths", async () => {
    const { media } = dirs();
    writeFileSync(join(media, "a.csv"), "x");
    symlinkSync(join(media, "a.csv"), join(media, "b.csv"));
    const r = await loadOutboundAttachments([{ path: join(media, "a.csv"), filename: "a.csv" }, { path: join(media, "b.csv"), filename: "b.csv" }], { roots: [media], maxBytes: 1000 });
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]!.type).toBe("text/csv");
  });

  it("cleans media-store names and maps extensions to content types", () => {
    expect(cleanMediaFilename("summary---0b9e8c3e-6f1d-4c52-9a7e-1d2f3a4b5c6d.txt")).toBe("summary.txt");
    expect(cleanMediaFilename("a---b.txt")).toBe("a---b.txt");
    expect(cleanMediaFilename("noext---0b9e8c3e-6f1d-4c52-9a7e-1d2f3a4b5c6d")).toBe("noext");
    expect(contentTypeFromFilename("x.PDF")).toBe("application/pdf");
    expect(contentTypeFromFilename("x.png")).toBe("image/png");
    expect(contentTypeFromFilename("x.unknownext")).toBe("application/octet-stream");
    expect(contentTypeFromFilename("noext")).toBe("application/octet-stream");
  });

  it("refuses arbitrary local paths, relative paths, traversal and symlinks that escape", async () => {
    const { base, media } = dirs();
    writeFileSync(join(base, "secret.txt"), "SECRET");
    symlinkSync(join(base, "secret.txt"), join(media, "link.txt"));
    const r = await loadOutboundAttachments(
      [
        { path: join(base, "secret.txt"), filename: "secret.txt" },
        { path: join(media, "..", "secret.txt"), filename: "t.txt" },
        { path: join(media, "link.txt"), filename: "link.txt" },
        { path: "relative.txt", filename: "relative.txt" },
        { path: "https://example.test/x.png", filename: "x.png" },
        { path: join(media, "missing.txt"), filename: "missing.txt" }
      ],
      { roots: [media], maxBytes: 1000 }
    );
    expect(r.attachments).toEqual([]);
    expect(r.notes).toHaveLength(6);
  });

  it("judges the real path: a symlinked directory or `../` that leaves the media directory is rejected, one that stays inside is not", async () => {
    const { base, media } = dirs();
    mkdirSync(join(base, "outside-dir"));
    writeFileSync(join(base, "outside-dir", "secret.txt"), "SECRET");
    writeFileSync(join(media, "ok.txt"), "OK");
    writeFileSync(join(media, "ok2.txt"), "OK2");
    mkdirSync(join(media, "sub"));
    symlinkSync(join(base, "outside-dir"), join(media, "dirlink"));
    symlinkSync(join(media, "ok2.txt"), join(media, "inner-link.txt"));
    const r = await loadOutboundAttachments(
      [
        { path: join(media, "dirlink", "secret.txt"), filename: "a.txt" },
        { path: join(media, "sub", "..", "..", "outside-dir", "secret.txt"), filename: "b.txt" },
        { path: join(media, "sub", "..", "ok.txt"), filename: "c.txt" },
        { path: join(media, "inner-link.txt"), filename: "d.txt" }
      ],
      { roots: [media], maxBytes: 1000 }
    );
    expect(r.attachments.map((a) => a.filename)).toEqual(["c.txt", "d.txt"]);
    expect(r.notes).toEqual(['Attachment "a.txt" was not sent.', 'Attachment "b.txt" was not sent.']);
  });

  it("omits an oversize file and says so", async () => {
    const { media } = dirs();
    writeFileSync(join(media, "big.bin"), Buffer.alloc(2048));
    const r = await loadOutboundAttachments([{ path: join(media, "big.bin"), filename: "big.bin" }], { roots: [media], maxBytes: 1024 });
    expect(r.attachments).toEqual([]);
    expect(r.notes[0]).toContain("over the");
  });

  it("sends them on reply, keeps them on a crash-recovery resend, and names omitted ones in the text", async () => {
    const { base, media } = dirs();
    writeFileSync(join(media, "a.txt"), "AAA");
    writeFileSync(join(base, "outside.txt"), "NO");
    let clock = Date.now();
    const h = makeHarness({
      now: () => clock,
      outbound: { roots: [media], maxBytes: 1000 },
      runAgentTurn: async () => ({ text: "see attached", media: [{ path: join(media, "a.txt"), filename: "a.txt" }, { path: join(base, "outside.txt"), filename: "outside.txt" }] })
    });
    h.api.replyImpl = async () => {
      throw new Error("socket hang up");
    };
    await receive(h, {});
    h.api.replyImpl = undefined;
    h.api.getThreadImpl = async () => {
      throw new Error("down");
    };
    clock += 61_000;
    await h.runtime.drain(); // recovery resends
    const sent = h.api.replies[0]!.params;
    expect(sent.attachments).toEqual([{ content: Buffer.from("AAA").toString("base64"), filename: "a.txt", type: "text/plain", disposition: "attachment" }]);
    expect(sent.text).toContain('Attachment "outside.txt" was not sent');
  });
});
