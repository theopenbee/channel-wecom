import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import type { MessageBody, StreamBody } from "./types.js";

export const MAX_TEXT_BYTES = 20_000;
export const THINKING_CONTENT = "<think></think>";

export function generateReqId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function chatIdOf(body: Pick<MessageBody, "chattype" | "chatid" | "from">): string {
  return body.chattype === "group" ? str(body.chatid) : str(asObject(body.from)?.userid);
}

export function streamBody(id: string, finish: boolean, content: string): StreamBody {
  return { msgtype: "stream", stream: { id, finish, content } };
}

export function encodeRaw(reqId: string, body: MessageBody): string {
  return JSON.stringify({
    headers: { req_id: reqId },
    body: {
      msgid: str(body.msgid),
      chatid: str(body.chatid),
      chattype: str(body.chattype),
      from: { userid: str(asObject(body.from)?.userid) },
    },
  });
}

export interface ReplyTarget {
  reqId: string;
  msgId: string;
  chatId: string;
}

export function parseRaw(raw: string | undefined): ReplyTarget | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const frame = asObject(parsed);
  const reqId = str(asObject(frame?.headers)?.req_id);
  const body = asObject(frame?.body);
  if (!reqId || !body) return undefined;
  return { reqId, msgId: str(body.msgid), chatId: chatIdOf(body as MessageBody) };
}

export function buildContext(body: MessageBody): Record<string, unknown> {
  return {
    msgid: str(body.msgid),
    aibotid: str(body.aibotid),
    chatid: str(body.chatid),
    chattype: str(body.chattype),
    from: { userid: str(asObject(body.from)?.userid) },
    msgtype: str(body.msgtype),
  };
}

function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

export function utf8PrefixLength(text: string, maxBytes: number): number {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const codePoint = text.codePointAt(i) as number;
    const size = utf8Size(codePoint);
    if (bytes + size > maxBytes) break;
    bytes += size;
    i += codePoint > 0xffff ? 2 : 1;
  }
  if (i === 0 && text.length > 0) {
    i = (text.codePointAt(0) as number) > 0xffff ? 2 : 1;
  }
  return i;
}

export function splitText(text: string, maxBytes = MAX_TEXT_BYTES): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (Buffer.byteLength(rest, "utf8") > maxBytes) {
    const limit = utf8PrefixLength(rest, maxBytes);
    const newline = rest.lastIndexOf("\n", limit - 1);
    const cut = newline > 0 ? newline + 1 : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function cleanErrmsg(errmsg: string): string {
  return errmsg.split(/,\s*(?:hint:|from ip:|more info at)/)[0].trim();
}

export function fileSentText(language: string): string {
  return language === "zh" ? "📎 文件已发送，请查收。" : "📎 File sent, please check.";
}

interface PendingStream {
  streamId: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export class PendingStreams {
  private readonly items = new Map<string, PendingStream>();

  constructor(
    private readonly ttl: number,
    private readonly file?: string,
    private readonly onSaveError?: (err: unknown) => void,
  ) {}

  static load(ttl: number, file: string, onSaveError?: (err: unknown) => void): { streams: PendingStreams; problem?: string } {
    const streams = new PendingStreams(ttl, file, onSaveError);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { streams };
      return { streams, problem: errorText(err) };
    }
    const now = Date.now();
    for (const [msgId, value] of Object.entries(asObject(parsed) ?? {})) {
      const entry = asObject(value);
      const streamId = str(entry?.stream_id);
      const expiresAt = typeof entry?.expires_at === "number" ? entry.expires_at : 0;
      if (msgId && streamId && expiresAt > now) streams.track(msgId, streamId, expiresAt);
    }
    return { streams };
  }

  get size(): number {
    return this.items.size;
  }

  set(msgId: string, streamId: string): void {
    if (!msgId) return;
    this.drop(msgId);
    this.track(msgId, streamId, Date.now() + this.ttl);
    this.save();
  }

  take(msgId: string): string | undefined {
    if (!msgId) return undefined;
    const item = this.drop(msgId);
    if (!item) return undefined;
    this.save();
    return item.streamId;
  }

  dispose(): void {
    for (const item of this.items.values()) clearTimeout(item.timer);
    this.items.clear();
  }

  private track(msgId: string, streamId: string, expiresAt: number): void {
    const timer = setTimeout(() => {
      if (this.drop(msgId)) this.save();
    }, Math.max(0, expiresAt - Date.now()));
    timer.unref();
    this.items.set(msgId, { streamId, expiresAt, timer });
  }

  private drop(msgId: string): PendingStream | undefined {
    const item = this.items.get(msgId);
    if (!item) return undefined;
    clearTimeout(item.timer);
    this.items.delete(msgId);
    return item;
  }

  private save(): void {
    if (!this.file) return;
    const data: Record<string, { stream_id: string; expires_at: number }> = {};
    for (const [msgId, item] of this.items) data[msgId] = { stream_id: item.streamId, expires_at: item.expiresAt };
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.onSaveError?.(err);
    }
  }
}
