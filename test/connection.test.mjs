import { test } from "node:test";
import assert from "node:assert/strict";

import { BOT_ID, SECRET, startFakeWeCom } from "./fake-wecom.mjs";
import { initialized } from "./harness.mjs";

const fast = { heartbeatInterval: 100, reconnectBaseDelay: 50, reconnectMaxDelay: 200, ackTimeout: 1000, subscribeTimeout: 1000 };

const textBody = (msgid, content) => ({ msgid, aibotid: BOT_ID, chattype: "single", from: { userid: "zhangsan" }, create_time: 1761300000, msgtype: "text", text: { content } });

test("rejected credentials are a config error", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const { p, res } = await initialized(t, fake, { config: { secret: "wrong" } });
  assert.equal(res.error.code, -32001);
  assert.equal(res.error.message, "WeCom rejected the bot credentials (errcode 853000: invalid bot_id or secret)");
  assert.equal(await p.exited, 1);
});

test("missing credentials are a config error", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const { p, res } = await initialized(t, fake, { config: { bot_id: "" } });
  assert.equal(res.error.code, -32001);
  assert.match(res.error.message, /bot_id is required/);
  assert.equal(await p.exited, 1);
  assert.equal(fake.connections(), 0);
});

test("other subscribe failures are transient start errors", async (t) => {
  const fake = await startFakeWeCom({ aibot_subscribe: (f) => ({ headers: { req_id: f.headers.req_id }, errcode: 600039, errmsg: "system busy" }) });
  t.after(() => fake.close());
  const { p, res } = await initialized(t, fake);
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /errcode=600039 msg=system busy/);
  assert.equal(await p.exited, 1);
});

test("dial failures are transient start errors", async (t) => {
  const { p, res } = await initialized(t, { url: "ws://127.0.0.1:1" });
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /wecom initial connect: dial/);
  assert.equal(await p.exited, 1);
});

test("start subscribes with the configured bot", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const { p, res } = await initialized(t, fake);
  assert.deepEqual(res.result, { protocol_version: 1 });
  const sub = fake.frames.find((f) => f.cmd === "aibot_subscribe");
  assert.match(sub.headers.req_id, /^aibot_subscribe-\d+-[0-9a-f]{8}$/);
  assert.deepEqual(sub.body, { bot_id: BOT_ID, secret: SECRET });
  assert.ok(!p.stderr().includes(SECRET));
  assert.ok(!JSON.stringify(p.messages).includes(SECRET));
});

test("reconnects and re-subscribes after the server drops the socket", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  fake.dropAll();
  await fake.waitFor((f) => f.cmd === "aibot_subscribe" && f.conn === 1, 5000);
  await p.waitLog((l) => l.message === "wecom reconnected");
  fake.callback(textBody("after-reconnect", "still there?"));
  const inbound = await p.waitInbound((m) => m.message_id === "after-reconnect");
  assert.equal(inbound.text, "still there?");
  const reconnecting = p.logs("info").find((l) => l.message === "wecom reconnecting");
  assert.deepEqual(reconnecting.fields, { attempt: 1, delay_ms: 1000 });
});

test("rejected credentials on reconnect keep retrying with backoff", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake, { timings: fast });
  fake.state.acceptCredentials = false;
  fake.dropAll();
  await fake.waitFor((f) => f.cmd === "aibot_subscribe" && f.conn === 3, 5000);
  const errors = p.logs("error").filter((l) => l.message === "wecom rejected the bot credentials on reconnect");
  assert.ok(errors.length >= 2);
  assert.equal(errors[0].fields.errcode, 853000);
  const delays = p.logs("info").filter((l) => l.message === "wecom reconnecting").map((l) => l.fields.delay_ms);
  assert.deepEqual(delays.slice(0, 3), [50, 100, 200]);
  fake.state.acceptCredentials = true;
  await p.waitLog((l) => l.message === "wecom reconnected", 5000);
  fake.callback(textBody("back", "ok again"));
  await p.waitInbound((m) => m.message_id === "back");
});

test("heartbeat pings keep the connection and missing acks force a reconnect", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake, { timings: fast });
  await new Promise((r) => setTimeout(r, 550));
  const pings = fake.frames.filter((f) => f.cmd === "ping");
  assert.ok(pings.length >= 3, `pings: ${pings.length}`);
  for (const ping of pings) assert.match(ping.headers.req_id, /^ping-\d+-[0-9a-f]{8}$/);
  assert.equal(fake.connections(), 1);

  fake.state.pingAck = false;
  const before = fake.frames.filter((f) => f.cmd === "ping").length;
  await fake.waitFor((f) => f.cmd === "aibot_subscribe" && f.conn === 1, 3000);
  const unanswered = fake.frames.filter((f) => f.cmd === "ping" && f.conn === 0).length - before;
  assert.equal(unanswered, 2);
  const warn = await p.waitLog((l) => l.message === "wecom heartbeat timeout, force-closing");
  assert.deepEqual(warn.fields, { missed: 2 });
});

test("events are dropped and a takeover is reported", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  fake.send({ cmd: "aibot_event_callback", headers: { req_id: "ev-1" }, body: { msgid: "e1", event: { eventtype: "enter_chat" } } });
  fake.send({ cmd: "aibot_event_callback", headers: { req_id: "ev-2" }, body: { msgid: "e2", event: { eventtype: "disconnected_event" } } });
  const dropped = await p.waitLog((l) => l.level === "debug" && l.message.startsWith("wecom event callback dropped"));
  assert.deepEqual(dropped.fields, { req_id: "ev-1", eventtype: "enter_chat" });
  const warn = await p.waitLog((l) => l.level === "warn" && /another connection took over/.test(l.message));
  assert.ok(warn);
  assert.equal(p.inbound().length, 0);
});

test("shutdown closes the connection and exits", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  const res = await p.request("shutdown", {});
  assert.deepEqual(res.result, {});
  assert.equal(await p.exited, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.open().length, 0);
});
