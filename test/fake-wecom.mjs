import { createCipheriv, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { WebSocketServer } from "ws";

export const BOT_ID = "aib-test-bot";
export const SECRET = "test-secret";
export const INVALID_CREDENTIALS_ERRMSG =
  "invalid bot_id or secret, hint: [1761300000_abc123], from ip: 203.0.113.7, more info at https://open.work.weixin.qq.com/devtool/query?e=853000";

export function encryptMedia(plain, key) {
  const pad = 32 - (plain.length % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

export function pngBytes(size = 64) {
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(Math.max(0, size - 8))]);
}

export function ok(frame, extra = {}) {
  return { headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: "ok", ...extra };
}

export async function startFakeWeCom(handlers = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const frames = [];
  const waiters = [];
  const sockets = [];
  const state = { acceptCredentials: true, pingAck: true, handlers: { ...handlers } };
  let uploads = 0;
  let callbacks = 0;

  const defaults = {
    aibot_subscribe: (f) =>
      state.acceptCredentials && f.body?.bot_id === BOT_ID && f.body?.secret === SECRET
        ? ok(f)
        : { headers: { req_id: f.headers.req_id }, errcode: 853000, errmsg: INVALID_CREDENTIALS_ERRMSG },
    ping: (f) => (state.pingAck ? ok(f) : null),
    aibot_upload_media_init: (f) => ok(f, { body: { upload_id: `upload-${++uploads}` } }),
    aibot_upload_media_finish: (f) => ok(f, { body: { media_id: `media-of-${f.body.upload_id}` } }),
  };

  wss.on("connection", (ws) => {
    const conn = sockets.length;
    sockets.push(ws);
    ws.on("message", async (data) => {
      const frame = JSON.parse(data.toString());
      frame.conn = conn;
      frames.push(frame);
      for (const w of [...waiters]) {
        if (w.match(frame)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(frame);
        }
      }
      const handler = state.handlers[frame.cmd] ?? defaults[frame.cmd] ?? ok;
      const reply = await handler(frame);
      if (reply && ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
    });
  });

  const { port } = wss.address();
  return {
    url: `ws://127.0.0.1:${port}`,
    frames,
    state,
    connections: () => sockets.length,
    open: () => sockets.filter((s) => s.readyState === s.OPEN),
    send(frame) {
      const socket = sockets.findLast((s) => s.readyState === s.OPEN);
      if (!socket) throw new Error("no open plugin connection");
      socket.send(JSON.stringify(frame));
    },
    callback(body, reqId = `cb-${++callbacks}-${randomBytes(3).toString("hex")}`) {
      this.send({ cmd: "aibot_msg_callback", headers: { req_id: reqId }, body });
      return reqId;
    },
    waitFor(match, ms = 5000) {
      const found = frames.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a frame from the plugin")), ms);
        waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
      });
    },
    dropAll() {
      for (const s of sockets) s.terminate();
    },
    close() {
      for (const s of sockets) s.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

export async function startMediaServer() {
  const files = new Map();
  const server = createServer((req, res) => {
    const data = files.get(req.url);
    if (!data) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(data);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    url: (path) => `${base}${path}`,
    add(path, data) {
      files.set(path, data);
      return `${base}${path}`;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
