import type { Attachment } from "@theopenbee/channel-sdk";

import { asObject, str } from "./helpers.js";
import type { EncryptedMedia, MessageBody, MixedContent, QuoteContent } from "./types.js";

export const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024;
export const SUPPORTED_MSG_TYPES = new Set(["text", "voice", "image", "file", "mixed"]);

export type MediaKind = "image" | "document";

export type Downloader = (media: EncryptedMedia, kind: MediaKind) => Promise<Attachment>;

export interface Extracted {
  text: string;
  attachments: Attachment[];
}

function joinText(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("\n");
}

function textOf(value: unknown): string | undefined {
  const obj = asObject(value);
  return obj ? str(obj.content) : undefined;
}

function mediaOf(value: unknown): EncryptedMedia | undefined {
  const obj = asObject(value);
  return obj ? { url: str(obj.url), aeskey: str(obj.aeskey) } : undefined;
}

export async function extractMixed(mixed: MixedContent, download: Downloader): Promise<Extracted> {
  const items = Array.isArray(mixed.msg_item) ? mixed.msg_item : [];
  const texts: string[] = [];
  const pending: Promise<Attachment>[] = [];
  for (const raw of items) {
    const item = asObject(raw);
    if (!item) continue;
    if (item.msgtype === "text") {
      const text = textOf(item.text);
      if (text) texts.push(text);
    } else if (item.msgtype === "image") {
      const media = mediaOf(item.image);
      if (media) pending.push(download(media, "image"));
    }
  }
  return { text: joinText(...texts), attachments: await Promise.all(pending) };
}

export async function extractQuote(quote: QuoteContent, download: Downloader): Promise<Extracted> {
  const none: Extracted = { text: "", attachments: [] };
  switch (quote.msgtype) {
    case "text":
    case "voice": {
      const text = textOf(quote.msgtype === "text" ? quote.text : quote.voice);
      return text === undefined ? none : { text, attachments: [] };
    }
    case "image":
    case "file": {
      const media = mediaOf(quote.msgtype === "image" ? quote.image : quote.file);
      if (!media) return none;
      return { text: "", attachments: [await download(media, quote.msgtype === "image" ? "image" : "document")] };
    }
    case "mixed": {
      const mixed = asObject(quote.mixed);
      return mixed ? extractMixed(mixed as MixedContent, download) : none;
    }
    default:
      return none;
  }
}

export async function extractContent(body: MessageBody, download: Downloader): Promise<Extracted | undefined> {
  let own: Extracted;
  switch (body.msgtype) {
    case "text":
    case "voice": {
      const text = textOf(body.msgtype === "text" ? body.text : body.voice);
      if (text === undefined) return undefined;
      own = { text, attachments: [] };
      break;
    }
    case "image":
    case "file": {
      const kind: MediaKind = body.msgtype === "image" ? "image" : "document";
      const media = mediaOf(body.msgtype === "image" ? body.image : body.file);
      if (!media) return { text: "", attachments: [{ type: kind, path: "" }] };
      own = { text: "", attachments: [await download(media, kind)] };
      break;
    }
    case "mixed": {
      const mixed = asObject(body.mixed);
      if (!mixed) return undefined;
      own = await extractMixed(mixed as MixedContent, download);
      break;
    }
    default:
      return undefined;
  }
  const quote = asObject(body.quote);
  if (quote) {
    const quoted = await extractQuote(quote as QuoteContent, download);
    own = { text: joinText(own.text, quoted.text), attachments: [...own.attachments, ...quoted.attachments] };
  }
  return own;
}

export async function fetchMedia(url: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`download returned HTTP ${res.status}`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(`download too large: more than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
