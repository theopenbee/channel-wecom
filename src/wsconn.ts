import type { Logger } from "@theopenbee/channel-sdk";
import WebSocket, { type RawData } from "ws";

import { asObject, errorText, generateReqId, str } from "./helpers.js";
import { CMD_CALLBACK, CMD_EVENT_CALLBACK, CMD_HEARTBEAT, CMD_SUBSCRIBE, ERRCODE_INVALID_CREDENTIALS, type WsFrame } from "./types.js";

export const MAX_MISSED_PONGS = 2;

export interface ConnTimings {
  heartbeatInterval: number;
  reconnectBaseDelay: number;
  reconnectMaxDelay: number;
  ackTimeout: number;
  subscribeTimeout: number;
}

export const DEFAULT_CONN_TIMINGS: ConnTimings = {
  heartbeatInterval: 30_000,
  reconnectBaseDelay: 1_000,
  reconnectMaxDelay: 30_000,
  ackTimeout: 5_000,
  subscribeTimeout: 10_000,
};

export interface WsConnOptions extends ConnTimings {
  url: string;
  botId: string;
  secret: string;
  log: Logger;
  onMessage(frame: WsFrame): void;
  onEvent(frame: WsFrame): void;
}

export class SubscribeError extends Error {
  constructor(
    readonly code: number,
    readonly errmsg: string,
  ) {
    super(`subscribe failed: errcode=${code} msg=${errmsg}`);
    this.name = "SubscribeError";
  }
}

export class AckError extends Error {
  constructor(
    readonly code: number,
    readonly errmsg: string,
  ) {
    super(`ack error: code=${code} msg=${errmsg}`);
    this.name = "AckError";
  }
}

interface PendingAck {
  resolve(frame: WsFrame): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface QueuedRequest {
  frame: WsFrame;
  resolve(frame: WsFrame): void;
  reject(err: Error): void;
}

export function parseFrame(data: RawData): WsFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return undefined;
  }
  const obj = asObject(parsed);
  if (!obj) return undefined;
  const frame: WsFrame = { headers: { req_id: str(asObject(obj.headers)?.req_id) } };
  if (typeof obj.cmd === "string" && obj.cmd) frame.cmd = obj.cmd;
  if (obj.body !== undefined) frame.body = obj.body;
  if (typeof obj.errcode === "number") frame.errcode = obj.errcode;
  if (typeof obj.errmsg === "string") frame.errmsg = obj.errmsg;
  return frame;
}

export class WsConn {
  private socket: WebSocket | undefined;
  private dialing: WebSocket | undefined;
  private closing = false;
  private missedPongs = 0;
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly queues = new Map<string, QueuedRequest[]>();
  private readonly pending = new Map<string, PendingAck>();

  constructor(private readonly opts: WsConnOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return this.dialAndSubscribe();
  }

  request(reqId: string, cmd: string, body: unknown): Promise<WsFrame> {
    return new Promise((resolve, reject) => {
      const entry: QueuedRequest = { frame: { cmd, headers: { req_id: reqId }, body }, resolve, reject };
      const queue = this.queues.get(reqId);
      if (queue) {
        queue.push(entry);
        return;
      }
      this.queues.set(reqId, [entry]);
      void this.drain(reqId);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.dialing?.terminate();
    this.rejectPending(new Error("connection closed"));
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => socket.terminate(), 1_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close(1000);
    });
  }

  private dialAndSubscribe(): Promise<void> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.opts.url, { handshakeTimeout: this.opts.subscribeTimeout });
      } catch (err) {
        reject(new Error(`dial: ${errorText(err)}`));
        return;
      }
      this.dialing = socket;
      let settled = false;
      const timer = setTimeout(() => fail(new Error("subscribe timeout")), this.opts.subscribeTimeout);
      const settle = () => {
        settled = true;
        clearTimeout(timer);
        if (this.dialing === socket) this.dialing = undefined;
      };
      const fail = (err: Error) => {
        if (settled) return;
        settle();
        socket.terminate();
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settle();
        if (this.closing) {
          socket.terminate();
          reject(new Error("connection closed"));
          return;
        }
        this.attach(socket);
        resolve();
      };
      const reqId = generateReqId(CMD_SUBSCRIBE);
      socket.on("open", () => {
        const frame: WsFrame = { cmd: CMD_SUBSCRIBE, headers: { req_id: reqId }, body: { bot_id: this.opts.botId, secret: this.opts.secret } };
        socket.send(JSON.stringify(frame), (err) => {
          if (err) fail(new Error(`send subscribe: ${err.message}`));
        });
      });
      socket.on("message", (data) => {
        const frame = parseFrame(data);
        if (!frame) {
          this.opts.log.warn("wecom ws parse error");
          return;
        }
        if (!settled && !frame.cmd && frame.headers.req_id.startsWith(CMD_SUBSCRIBE)) {
          if (frame.errcode) fail(new SubscribeError(frame.errcode, frame.errmsg ?? ""));
          else succeed();
          return;
        }
        this.handleFrame(socket, frame);
      });
      socket.on("error", (err) => {
        if (!settled) fail(new Error(`dial: ${err.message}`));
        else if (!this.closing) this.opts.log.warn("wecom ws error", { error: err.message });
      });
      socket.on("close", (code, reason) => {
        if (!settled) {
          fail(new Error(`connection closed before subscribe ack (code ${code})`));
          return;
        }
        this.onClose(socket, code, reason.toString());
      });
    });
  }

  private attach(socket: WebSocket): void {
    this.socket = socket;
    this.missedPongs = 0;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeat(socket), this.opts.heartbeatInterval);
    this.opts.log.info("wecom authenticated");
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private heartbeat(socket: WebSocket): void {
    if (socket !== this.socket) return;
    if (this.missedPongs >= MAX_MISSED_PONGS) {
      this.opts.log.warn("wecom heartbeat timeout, force-closing", { missed: this.missedPongs });
      socket.terminate();
      return;
    }
    this.missedPongs++;
    const frame: WsFrame = { cmd: CMD_HEARTBEAT, headers: { req_id: generateReqId(CMD_HEARTBEAT) } };
    socket.send(JSON.stringify(frame), (err) => {
      if (!err) return;
      this.opts.log.warn("wecom heartbeat send failed", { error: err.message });
      socket.terminate();
    });
  }

  private handleFrame(socket: WebSocket, frame: WsFrame): void {
    const reqId = frame.headers.req_id;
    if (frame.cmd === CMD_CALLBACK) {
      this.opts.log.info("wecom message received", { req_id: reqId });
      this.opts.onMessage(frame);
      return;
    }
    if (frame.cmd === CMD_EVENT_CALLBACK) {
      this.opts.onEvent(frame);
      return;
    }
    if (reqId.startsWith(CMD_SUBSCRIBE)) return;
    if (reqId.startsWith(CMD_HEARTBEAT)) {
      if (frame.errcode) {
        this.opts.log.warn("wecom heartbeat ack error", { errcode: frame.errcode });
        return;
      }
      if (socket === this.socket) this.missedPongs = 0;
      this.opts.log.debug("wecom heartbeat ack");
      return;
    }
    this.releaseAck(reqId, frame);
  }

  private onClose(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.stopHeartbeat();
    this.rejectPending(new Error("connection closed before ack"));
    if (this.closing) return;
    this.opts.log.warn("wecom connection closed", { code, reason });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const attempt = ++this.reconnectAttempts;
    const delay = Math.min(this.opts.reconnectBaseDelay * 2 ** Math.min(attempt - 1, 30), this.opts.reconnectMaxDelay);
    this.opts.log.info("wecom reconnecting", { attempt, delay_ms: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closing) return;
      this.dialAndSubscribe().then(
        () => {
          this.opts.log.info("wecom reconnected", { attempt });
          this.reconnectAttempts = 0;
        },
        (err: unknown) => {
          if (this.closing) return;
          if (err instanceof SubscribeError && err.code === ERRCODE_INVALID_CREDENTIALS) {
            this.opts.log.error("wecom rejected the bot credentials on reconnect", { attempt, errcode: err.code });
          } else {
            this.opts.log.error("wecom reconnect failed", { attempt, error: errorText(err) });
          }
          this.scheduleReconnect();
        },
      );
    }, delay);
  }

  private async drain(reqId: string): Promise<void> {
    const queue = this.queues.get(reqId) as QueuedRequest[];
    while (queue.length > 0) {
      const entry = queue[0];
      try {
        entry.resolve(await this.sendAndWait(entry.frame));
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
      queue.shift();
    }
    this.queues.delete(reqId);
  }

  private sendAndWait(frame: WsFrame): Promise<WsFrame> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
    const reqId = frame.headers.req_id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`ack timeout (${this.opts.ackTimeout}ms) for reqID ${reqId}`));
      }, this.opts.ackTimeout);
      const entry: PendingAck = { resolve, reject, timer };
      this.pending.set(reqId, entry);
      socket.send(JSON.stringify(frame), (err) => {
        if (!err || this.pending.get(reqId) !== entry) return;
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new Error(`send frame: ${err.message}`));
      });
    });
  }

  private releaseAck(reqId: string, frame: WsFrame): void {
    const entry = this.pending.get(reqId);
    if (!entry) {
      this.opts.log.debug("wecom unexpected ack (ignored)", { req_id: reqId });
      return;
    }
    this.pending.delete(reqId);
    clearTimeout(entry.timer);
    if (frame.errcode) entry.reject(new AckError(frame.errcode, frame.errmsg ?? ""));
    else entry.resolve(frame);
  }

  private rejectPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
