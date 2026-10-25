import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { ConfigError, type Attachment, type ChannelContext, type ChannelDefinition, type SendRequest } from "@theopenbee/channel-sdk";

import { decryptFile } from "./crypto.js";
import {
  PendingStreams,
  THINKING_CONTENT,
  asObject,
  buildContext,
  chatIdOf,
  cleanErrmsg,
  encodeRaw,
  errorText,
  fileSentText,
  generateReqId,
  parseRaw,
  splitText,
  str,
  streamBody,
  type ReplyTarget,
} from "./helpers.js";
import { MAX_DOWNLOAD_SIZE, SUPPORTED_MSG_TYPES, extractContent, fetchMedia, type Downloader } from "./inbound.js";
import { CHUNK_SIZE, detectMime, extensionFromMime, resolveMediaType, type WeComMediaType } from "./mime.js";
import {
  CMD_RESPOND,
  CMD_SEND_MSG,
  CMD_UPLOAD_CHUNK,
  CMD_UPLOAD_FINISH,
  CMD_UPLOAD_INIT,
  ERRCODE_INVALID_CREDENTIALS,
  type MessageBody,
  type WsFrame,
} from "./types.js";
import { AckError, DEFAULT_CONN_TIMINGS, SubscribeError, WsConn, type ConnTimings } from "./wsconn.js";

export const DEFAULT_WEBSOCKET_URL = "wss://openws.work.weixin.qq.com";

export interface Timings extends ConnTimings {
  pendingStreamTtl: number;
  downloadTimeout: number;
}

export const DEFAULT_TIMINGS: Timings = {
  ...DEFAULT_CONN_TIMINGS,
  pendingStreamTtl: 10 * 60_000,
  downloadTimeout: 120_000,
};

interface WeComConfig {
  botId: string;
  secret: string;
  websocketUrl: string;
}

function configString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readConfig(raw: Record<string, unknown>): WeComConfig {
  const botId = configString(raw.bot_id);
  if (!botId) throw new ConfigError("bot_id is required");
  const secret = configString(raw.secret);
  if (!secret) throw new ConfigError("secret is required");
  const websocketUrl = configString(raw.websocket_url) || DEFAULT_WEBSOCKET_URL;
  if (!/^wss?:\/\//i.test(websocketUrl)) throw new ConfigError("websocket_url must start with ws:// or wss://");
  return { botId, secret, websocketUrl };
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("send cancelled");
}

async function step<T>(label: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    throw new Error(`${label}: ${errorText(err)}`, { cause: err });
  }
}

export function createWeComChannel(overrides: Partial<Timings> = {}): ChannelDefinition {
  const timings: Timings = { ...DEFAULT_TIMINGS, ...overrides };
  let conn: WsConn | undefined;
  let streams: PendingStreams | undefined;

  const request = (reqId: string, cmd: string, body: unknown): Promise<WsFrame> => {
    if (!conn) return Promise.reject(new Error("wecom bot is not started"));
    return conn.request(reqId, cmd, body);
  };

  const downloader =
    (ctx: ChannelContext): Downloader =>
    async (media, kind) => {
      const url = media.url ?? "";
      if (!url) return { type: kind, path: "" };
      try {
        let data: Buffer = await fetchMedia(url, MAX_DOWNLOAD_SIZE, timings.downloadTimeout);
        if (media.aeskey) data = decryptFile(data, media.aeskey);
        const path = await ctx.saveMedia(data, extensionFromMime(detectMime(data)));
        return { type: kind, path };
      } catch (err) {
        ctx.log.error("wecom media download failed", { type: kind, error: errorText(err) });
        return { type: kind, path: "" };
      }
    };

  const handleCallback = async (ctx: ChannelContext, frame: WsFrame) => {
    const body = asObject(frame.body) as MessageBody | undefined;
    if (!body) {
      ctx.log.warn("wecom: failed to parse message body");
      return;
    }
    const msgType = str(body.msgtype);
    if (!SUPPORTED_MSG_TYPES.has(msgType)) {
      ctx.log.warn("wecom: skipping unsupported msgtype", { msgtype: msgType });
      return;
    }
    const chatId = chatIdOf(body);
    const senderId = str(asObject(body.from)?.userid);
    if (!chatId || chatId.includes(":") || !senderId) {
      ctx.log.warn("wecom: dropping message without a usable chat or sender id", { chattype: str(body.chattype) });
      return;
    }
    const content = await extractContent(body, downloader(ctx));
    if (!content || (!content.text && content.attachments.length === 0)) return;

    const reqId = frame.headers.req_id;
    const streamId = generateReqId("stream");
    try {
      await request(reqId, CMD_RESPOND, streamBody(streamId, false, THINKING_CONTENT));
    } catch (err) {
      ctx.log.warn("wecom: failed to send thinking message", { error: errorText(err) });
    }
    const msgId = str(body.msgid);
    streams?.set(msgId, streamId);

    const createTime = typeof body.create_time === "number" && body.create_time > 0 ? body.create_time : 0;
    ctx.dispatch({
      chat_id: chatId,
      sender_id: senderId,
      message_id: msgId || undefined,
      text: content.text,
      attachments: content.attachments,
      raw: encodeRaw(reqId, body),
      context: buildContext(body),
      time: createTime ? createTime * 1000 : undefined,
    });
  };

  const handleEvent = (ctx: ChannelContext, frame: WsFrame) => {
    const eventType = str(asObject(asObject(frame.body)?.event)?.eventtype);
    if (eventType === "disconnected_event") {
      ctx.log.warn("wecom: another connection took over this bot; messages now go to that connection");
      return;
    }
    ctx.log.debug("wecom event callback dropped (out of scope)", { req_id: frame.headers.req_id, eventtype: eventType });
  };

  const sendMarkdown = (chatId: string, content: string) =>
    step("send markdown message", request(generateReqId(CMD_SEND_MSG), CMD_SEND_MSG, { chatid: chatId, msgtype: "markdown", markdown: { content } }));

  const uploadMedia = async (data: Buffer, type: WeComMediaType, filename: string, signal: AbortSignal): Promise<string> => {
    const totalSize = data.length;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    const md5 = createHash("md5").update(data).digest("hex");
    checkAborted(signal);
    const init = await step(
      "upload init",
      request(generateReqId(CMD_UPLOAD_INIT), CMD_UPLOAD_INIT, {
        type,
        filename: basename(filename),
        total_size: totalSize,
        total_chunks: totalChunks,
        md5,
      }),
    );
    const uploadId = str(asObject(init.body)?.upload_id);
    if (!uploadId) throw new Error("upload init: no upload_id in response");
    for (let i = 0; i < totalChunks; i++) {
      checkAborted(signal);
      const chunk = data.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, totalSize));
      await step(
        `upload chunk ${i}`,
        request(generateReqId(CMD_UPLOAD_CHUNK), CMD_UPLOAD_CHUNK, { upload_id: uploadId, chunk_index: i, base64_data: chunk.toString("base64") }),
      );
    }
    checkAborted(signal);
    const finish = await step("upload finish", request(generateReqId(CMD_UPLOAD_FINISH), CMD_UPLOAD_FINISH, { upload_id: uploadId }));
    const mediaId = str(asObject(finish.body)?.media_id);
    if (!mediaId) throw new Error("upload finish: no media_id in response");
    return mediaId;
  };

  const pushMedia = async (chatId: string, media: NonNullable<SendRequest["media"]>, signal: AbortSignal) => {
    checkAborted(signal);
    const data = await step("read media file", readFile(media.path));
    const name = media.name || basename(media.path);
    const type = resolveMediaType(detectMime(data, name), data.length);
    const mediaId = await uploadMedia(data, type, name, signal);
    checkAborted(signal);
    await step(
      "send media message",
      request(generateReqId(CMD_SEND_MSG), CMD_SEND_MSG, { chatid: chatId, msgtype: type, [type]: { media_id: mediaId } }),
    );
  };

  const replyText = async (ctx: ChannelContext, target: ReplyTarget, chatId: string, streamId: string, content: string) => {
    try {
      await request(target.reqId, CMD_RESPOND, streamBody(streamId, true, content));
    } catch (err) {
      if (!(err instanceof AckError)) throw new Error(`stream reply: ${errorText(err)}`, { cause: err });
      ctx.log.warn("wecom: stream reply rejected, sending a new message instead", { errcode: err.code, errmsg: err.errmsg });
      await sendMarkdown(chatId, content);
    }
  };

  const finishWithFileSent = async (ctx: ChannelContext, target: ReplyTarget, streamId: string) => {
    try {
      await request(target.reqId, CMD_RESPOND, streamBody(streamId, true, fileSentText(ctx.language)));
    } catch (err) {
      if (!(err instanceof AckError)) throw new Error(`finish stream: ${errorText(err)}`, { cause: err });
      ctx.log.warn("wecom: could not finish the reply stream after sending the file", { errcode: err.code, errmsg: err.errmsg });
    }
  };

  const sendReply = async (ctx: ChannelContext, msg: SendRequest, target: ReplyTarget, chunks: string[], signal: AbortSignal) => {
    const chatId = target.chatId || msg.chat_id;
    const streamId = streams?.take(target.msgId) ?? generateReqId("stream");
    if (chunks.length > 0) {
      checkAborted(signal);
      await replyText(ctx, target, chatId, streamId, chunks[0]);
      for (const chunk of chunks.slice(1)) {
        checkAborted(signal);
        await sendMarkdown(chatId, chunk);
      }
      if (msg.media) await pushMedia(chatId, msg.media, signal);
      return;
    }
    if (msg.media) {
      await pushMedia(chatId, msg.media, signal);
      checkAborted(signal);
      await finishWithFileSent(ctx, target, streamId);
    }
  };

  const sendProactive = async (msg: SendRequest, chunks: string[], signal: AbortSignal) => {
    for (const chunk of chunks) {
      checkAborted(signal);
      await sendMarkdown(msg.chat_id, chunk);
    }
    if (msg.media) await pushMedia(msg.chat_id, msg.media, signal);
  };

  return {
    async start(ctx) {
      const cfg = readConfig(ctx.config);
      streams = new PendingStreams(timings.pendingStreamTtl);
      const ws = new WsConn({
        ...timings,
        url: cfg.websocketUrl,
        botId: cfg.botId,
        secret: cfg.secret,
        log: ctx.log,
        onMessage: (frame) => {
          handleCallback(ctx, frame).catch((err) => ctx.log.error("wecom: handle message failed", { error: errorText(err) }));
        },
        onEvent: (frame) => handleEvent(ctx, frame),
      });
      conn = ws;
      ctx.log.info("WeCom bot starting");
      try {
        await ws.connect();
      } catch (err) {
        if (err instanceof SubscribeError && err.code === ERRCODE_INVALID_CREDENTIALS) {
          throw new ConfigError(`WeCom rejected the bot credentials (errcode ${err.code}: ${cleanErrmsg(err.errmsg)})`);
        }
        throw new Error(`wecom initial connect: ${errorText(err)}`);
      }
      return {
        stop: async () => {
          await ws.close();
          streams?.clear();
        },
      };
    },

    async send(msg, ctx, signal) {
      if (!conn) throw new Error("wecom bot is not started");
      const target = msg.proactive ? undefined : parseRaw(msg.reply_to?.raw);
      const chunks = msg.content ? splitText(msg.content) : [];
      if (target) await sendReply(ctx, msg, target, chunks, signal);
      else await sendProactive(msg, chunks, signal);
      return {};
    },
  };
}
