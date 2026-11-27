import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";

type SaveFn = typeof saveMediaBuffer;

/**
 * Stores an inbound attachment in OpenClaw's media directory. The account's
 * `mediaMaxMb` is passed as the cap: left undefined, OpenClaw applies its own
 * 5 MB default and rejects larger files the account allows.
 */
export async function saveInboundMedia(
  buf: Buffer,
  info: { filename: string; contentType?: string; maxBytes: number },
  save: SaveFn = saveMediaBuffer
): Promise<{ path: string; contentType?: string }> {
  const saved = await save(buf, info.contentType, "mailtrap", info.maxBytes, info.filename);
  return { path: saved.path, contentType: saved.contentType };
}
