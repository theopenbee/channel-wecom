import { test } from "node:test";
import assert from "node:assert/strict";

import { AckError, SubscribeError, WsConn, parseFrame } from "../dist/wsconn.js";
import { BOT_ID, SECRET, ok, startFakeWeCom } from "./fake-wecom.mjs";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function recordingLog() {
  const lines = [];
  const at = (level) => (message, fields) => lines.push({ level, message, fields });
  return { lines, log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } };
}

function newConn(url, extra = {}) {
  return new WsConn({
    url,
    botId: BOT_ID,
    secret: SECRET,
    heartbeatInterval: 60_000,
    reconnectBaseDelay: 20,
    reconnectMaxDelay: 100,
    ackTimeout: 300,
    subscribeTimeout: 1_000,
    log: silent,
    onMessage() {},
    onEvent() {},
    ...extra,
  });
}

test("parseFrame normalizes frames", () => {
  assert.deepEqual(parseFrame(Buffer.from('{"headers":{"req_id":"r"},"errcode":0,"errmsg":"ok"}')), { headers: { req_id: "r" }, errcode: 0, errmsg: "ok" });
  assert.deepEqual(parseFrame(Buffer.from('{"cmd":"ping"}')), { cmd: "ping", headers: { req_id: "" } });
  assert.equal(parseFrame(Buffer.from("nope")), undefined);
  assert.equal(parseFrame(Buffer.from("[1]")), undefined);
});

test("subscribe sends the credentials and resolves on the ack", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const conn = newConn(fake.url);
  t.after(() => conn.close());
  await conn.connect();
  assert.ok(conn.connected);
  const sub = fake.frames.find((f) => f.cmd === "aibot_subscribe");
  assert.match(sub.headers.req_id, /^aibot_subscribe-\d+-[0-9a-f]{8}$/);
  assert.deepEqual(sub.body, { bot_id: BOT_ID, secret: SECRET });
});

test("subscribe errors carry the errcode", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const conn = newConn(fake.url, { secret: "wrong" });
  const err = await conn.connect().then(() => undefined, (e) => e);
  assert.ok(err instanceof SubscribeError);
  assert.equal(err.code, 853000);
  assert.equal(conn.connected, false);
});

test("subscribe times out when the server never acks", async (t) => {
  const fake = await startFakeWeCom({ aibot_subscribe: () => null });
  t.after(() => fake.close());
  const conn = newConn(fake.url, { subscribeTimeout: 200 });
  await assert.rejects(conn.connect(), /subscribe timeout/);
});

test("dial failures are plain errors", async () => {
  const conn = newConn("ws://127.0.0.1:1");
  const err = await conn.connect().then(() => undefined, (e) => e);
  assert.ok(err instanceof Error && !(err instanceof SubscribeError));
  assert.match(err.message, /^dial: /);
});

test("frames with the same req_id wait for each other's ack", async (t) => {
  const held = [];
  const fake = await startFakeWeCom({
    aibot_respond_msg: (f) => new Promise((resolve) => held.push(() => resolve(ok(f, { body: { n: f.body.n } })))),
  });
  t.after(() => fake.close());
  const conn = newConn(fake.url, { ackTimeout: 2_000 });
  t.after(() => conn.close());
  await conn.connect();
  const first = conn.request("same", "aibot_respond_msg", { n: 1 });
  const second = conn.request("same", "aibot_respond_msg", { n: 2 });
  const other = conn.request("other", "aibot_respond_msg", { n: 3 });
  await fake.waitFor((f) => f.headers.req_id === "other");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    fake.frames.filter((f) => f.cmd === "aibot_respond_msg").map((f) => f.body.n),
    [1, 3],
  );
  held.shift()();
  assert.deepEqual((await first).body, { n: 1 });
  await fake.waitFor((f) => f.body?.n === 2);
  while (held.length) held.shift()();
  assert.deepEqual((await second).body, { n: 2 });
  assert.deepEqual((await other).body, { n: 3 });
});

test("ack errors, ack timeouts and missing connections reject", async (t) => {
  const fake = await startFakeWeCom({
    aibot_send_msg: (f) => ({ headers: { req_id: f.headers.req_id }, errcode: 40008, errmsg: "invalid message type" }),
    aibot_respond_msg: () => null,
  });
  t.after(() => fake.close());
  const conn = newConn(fake.url, { ackTimeout: 150 });
  await assert.rejects(conn.request("r0", "aibot_send_msg", {}), /not connected/);
  await conn.connect();
  const err = await conn.request("r1", "aibot_send_msg", {}).then(() => undefined, (e) => e);
  assert.ok(err instanceof AckError);
  assert.equal(err.message, "ack error: code=40008 msg=invalid message type");
  await assert.rejects(conn.request("r2", "aibot_respond_msg", {}), /ack timeout \(150ms\) for reqID r2/);
  await conn.close();
  await assert.rejects(conn.request("r3", "aibot_send_msg", {}), /not connected/);
});

test("a dropped connection fails pending requests and reconnects", async (t) => {
  const fake = await startFakeWeCom({ aibot_respond_msg: () => null });
  t.after(() => fake.close());
  const { lines, log } = recordingLog();
  const conn = newConn(fake.url, { ackTimeout: 5_000, log });
  t.after(() => conn.close());
  await conn.connect();
  const pending = conn.request("r1", "aibot_respond_msg", {});
  await fake.waitFor((f) => f.headers.req_id === "r1");
  fake.dropAll();
  await assert.rejects(pending, /connection closed before ack/);
  await fake.waitFor((f) => f.cmd === "aibot_subscribe" && f.conn === 1);
  while (!conn.connected) await new Promise((r) => setTimeout(r, 10));
  assert.ok(lines.some((l) => l.message === "wecom reconnecting" && l.fields.attempt === 1));
});

test("callbacks and events are routed", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const messages = [];
  const events = [];
  const conn = newConn(fake.url, { onMessage: (f) => messages.push(f), onEvent: (f) => events.push(f) });
  t.after(() => conn.close());
  await conn.connect();
  fake.send({ cmd: "aibot_event_callback", headers: { req_id: "e1" }, body: { event: { eventtype: "enter_chat" } } });
  fake.callback({ msgid: "m1" }, "c1");
  while (messages.length === 0) await new Promise((r) => setTimeout(r, 10));
  assert.equal(messages[0].headers.req_id, "c1");
  assert.deepEqual(messages[0].body, { msgid: "m1" });
  assert.equal(events[0].headers.req_id, "e1");
});
