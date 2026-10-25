import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BOT_ID, pngBytes, startFakeWeCom } from "./fake-wecom.mjs";
import { initialized, send, setup } from "./harness.mjs";

let seq = 0;
function body(overrides = {}) {
  seq += 1;
  return {
    msgid: `msg-${seq}`,
    aibotid: BOT_ID,
    chattype: "single",
    from: { userid: "zhangsan" },
    create_time: 1761300000,
    msgtype: "text",
    text: { content: "question" },
    ...overrides,
  };
}

const finishRejected = (f) =>
  f.body?.stream?.finish ? { headers: { req_id: f.headers.req_id }, errcode: 846608, errmsg: "stream message expired" } : { headers: { req_id: f.headers.req_id }, errcode: 0, errmsg: "ok" };

async function env(t, { handlers, language, timings } = {}) {
  const fake = await startFakeWeCom(handlers);
  t.after(() => fake.close());
  const { p, dirs } = await initialized(t, fake, { language, timings });
  return { fake, p, dirs };
}

async function receive(fake, p, b = body()) {
  const reqId = fake.callback(b);
  const inbound = await p.waitInbound((m) => m.message_id === b.msgid);
  const thinking = fake.frames.find((f) => f.cmd === "aibot_respond_msg" && f.headers.req_id === reqId);
  return { reqId, inbound, streamId: thinking.body.stream.id, body: b };
}

function framesAfter(fake, mark) {
  return fake.frames.slice(mark).filter((f) => f.cmd !== "ping");
}

test("text replies finish the thinking stream", async (t) => {
  const { fake, p } = await env(t);
  const { reqId, inbound, streamId } = await receive(fake, p);
  const mark = fake.frames.length;
  const res = await send(p, { chat_id: inbound.chat_id, reply_to: { message_id: inbound.message_id, raw: inbound.raw }, content: "hello back" });
  assert.deepEqual(res.result, {});
  const sent = framesAfter(fake, mark);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].cmd, "aibot_respond_msg");
  assert.equal(sent[0].headers.req_id, reqId);
  assert.deepEqual(sent[0].body, { msgtype: "stream", stream: { id: streamId, finish: true, content: "hello back" } });

  const again = fake.frames.length;
  await send(p, { chat_id: inbound.chat_id, reply_to: { message_id: inbound.message_id, raw: inbound.raw }, content: "one more" });
  const second = framesAfter(fake, again)[0];
  assert.equal(second.headers.req_id, reqId);
  assert.notEqual(second.body.stream.id, streamId);
  assert.match(second.body.stream.id, /^stream-\d+-[0-9a-f]{8}$/);
});

test("a reply after a plugin restart finishes the original thinking stream", async (t) => {
  const fake = await startFakeWeCom();
  t.after(() => fake.close());
  const dirs = setup();
  const first = await initialized(t, fake, { dirs });
  const { reqId, inbound, streamId } = await receive(fake, first.p);
  first.p.child.stdin.end();
  assert.equal(await first.p.exited, 0);

  const second = await initialized(t, fake, { dirs });
  const mark = fake.frames.length;
  await send(second.p, { chat_id: inbound.chat_id, reply_to: { message_id: inbound.message_id, raw: inbound.raw }, content: "after restart" });
  const [reply] = framesAfter(fake, mark);
  assert.equal(reply.headers.req_id, reqId);
  assert.deepEqual(reply.body, { msgtype: "stream", stream: { id: streamId, finish: true, content: "after restart" } });
  assert.deepEqual(JSON.parse(readFileSync(join(dirs.dataDir, "pending-streams.json"), "utf8")), {});
});

test("a rejected stream reply is sent as a new message", async (t) => {
  const { fake, p } = await env(t, { handlers: { aibot_respond_msg: finishRejected } });
  const { inbound } = await receive(fake, p, body({ chattype: "group", chatid: "wrkGroup42" }));
  const mark = fake.frames.length;
  const res = await send(p, { chat_id: inbound.chat_id, reply_to: { message_id: inbound.message_id, raw: inbound.raw }, content: "late answer" });
  assert.deepEqual(res.result, {});
  const sent = framesAfter(fake, mark);
  assert.deepEqual(sent.map((f) => f.cmd), ["aibot_respond_msg", "aibot_send_msg"]);
  assert.match(sent[1].headers.req_id, /^aibot_send_msg-\d+-[0-9a-f]{8}$/);
  assert.deepEqual(sent[1].body, { chatid: "wrkGroup42", msgtype: "markdown", markdown: { content: "late answer" } });
  const warn = p.logs("warn").find((l) => l.message === "wecom: stream reply rejected, sending a new message instead");
  assert.deepEqual(warn.fields, { errcode: 846608, errmsg: "stream message expired" });
});

test("an ack timeout on the stream reply fails without a fallback", async (t) => {
  const { fake, p } = await env(t, {
    timings: { ackTimeout: 300 },
    handlers: { aibot_respond_msg: (f) => (f.body.stream.finish ? null : { headers: { req_id: f.headers.req_id }, errcode: 0 }) },
  });
  const { inbound } = await receive(fake, p);
  const res = await send(p, { chat_id: inbound.chat_id, reply_to: { raw: inbound.raw }, content: "maybe delivered" });
  assert.equal(res.error.code, -32000);
  assert.match(res.error.message, /^stream reply: ack timeout \(300ms\)/);
  assert.equal(fake.frames.filter((f) => f.cmd === "aibot_send_msg").length, 0);
});

test("media replies upload in 512 KiB chunks, then finish the stream", async (t) => {
  const { fake, p, dirs } = await env(t, { language: "zh" });
  const { reqId, inbound, streamId } = await receive(fake, p);
  const file = join(dirs.mediaDir, "chart.png");
  const data = pngBytes(600 * 1024);
  writeFileSync(file, data);
  const mark = fake.frames.length;
  const res = await send(p, { chat_id: inbound.chat_id, reply_to: { raw: inbound.raw }, media: { path: file, name: "chart.png" } });
  assert.deepEqual(res.result, {});
  const sent = framesAfter(fake, mark);
  assert.deepEqual(sent.map((f) => f.cmd), [
    "aibot_upload_media_init",
    "aibot_upload_media_chunk",
    "aibot_upload_media_chunk",
    "aibot_upload_media_finish",
    "aibot_send_msg",
    "aibot_respond_msg",
  ]);
  const [init, c0, c1, finish, sendMsg, done] = sent;
  for (const f of [init, c0, c1, finish, sendMsg]) assert.ok(f.headers.req_id.startsWith(`${f.cmd}-`), f.headers.req_id);
  assert.equal(new Set(sent.slice(0, 5).map((f) => f.headers.req_id)).size, 5);
  assert.deepEqual(init.body, {
    type: "image",
    filename: "chart.png",
    total_size: data.length,
    total_chunks: 2,
    md5: createHash("md5").update(data).digest("hex"),
  });
  assert.equal(c0.body.upload_id, "upload-1");
  assert.deepEqual([c0.body.chunk_index, c1.body.chunk_index], [0, 1]);
  assert.equal(Buffer.from(c0.body.base64_data, "base64").length, 512 * 1024);
  assert.deepEqual(Buffer.concat([Buffer.from(c0.body.base64_data, "base64"), Buffer.from(c1.body.base64_data, "base64")]), data);
  assert.deepEqual(finish.body, { upload_id: "upload-1" });
  assert.deepEqual(sendMsg.body, { chatid: "zhangsan", msgtype: "image", image: { media_id: "media-of-upload-1" } });
  assert.equal(done.headers.req_id, reqId);
  assert.deepEqual(done.body, { msgtype: "stream", stream: { id: streamId, finish: true, content: "📎 文件已发送，请查收。" } });
});

test("text with media finishes the stream with the text, then pushes the file", async (t) => {
  const { fake, p, dirs } = await env(t);
  const { reqId, inbound, streamId } = await receive(fake, p);
  const file = join(dirs.mediaDir, "report.pdf");
  writeFileSync(file, Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(1000)]));
  const mark = fake.frames.length;
  const res = await send(p, { chat_id: inbound.chat_id, reply_to: { raw: inbound.raw }, content: "Here is the report", media: { path: file, name: "report.pdf" } });
  assert.deepEqual(res.result, {});
  const sent = framesAfter(fake, mark);
  assert.deepEqual(sent.map((f) => f.cmd), ["aibot_respond_msg", "aibot_upload_media_init", "aibot_upload_media_chunk", "aibot_upload_media_finish", "aibot_send_msg"]);
  assert.equal(sent[0].headers.req_id, reqId);
  assert.deepEqual(sent[0].body.stream, { id: streamId, finish: true, content: "Here is the report" });
  assert.equal(sent[1].body.type, "file");
  assert.deepEqual(sent[4].body, { chatid: "zhangsan", msgtype: "file", file: { media_id: "media-of-upload-1" } });
});

test("a media reply whose stream cannot be finished still succeeds", async (t) => {
  const { fake, p, dirs } = await env(t, { handlers: { aibot_respond_msg: finishRejected } });
  const { inbound } = await receive(fake, p);
  const file = join(dirs.mediaDir, "a.png");
  writeFileSync(file, pngBytes(100));
  const res = await send(p, { chat_id: inbound.chat_id, reply_to: { raw: inbound.raw }, media: { path: file, name: "a.png" } });
  assert.deepEqual(res.result, {});
  assert.ok(p.logs("warn").some((l) => l.message === "wecom: could not finish the reply stream after sending the file"));
  assert.equal(fake.frames.filter((f) => f.cmd === "aibot_send_msg" && f.body.msgtype === "markdown").length, 0);
});

test("proactive text is pushed as markdown and leaves the pending stream alone", async (t) => {
  const { fake, p } = await env(t);
  const { reqId, inbound, streamId } = await receive(fake, p);
  const mark = fake.frames.length;
  const res = await send(p, { chat_id: "zhangsan", proactive: true, reply_to: { raw: inbound.raw }, content: "daily report" });
  assert.deepEqual(res.result, {});
  const sent = framesAfter(fake, mark);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].cmd, "aibot_send_msg");
  assert.notEqual(sent[0].headers.req_id, reqId);
  assert.deepEqual(sent[0].body, { chatid: "zhangsan", msgtype: "markdown", markdown: { content: "daily report" } });
  const later = fake.frames.length;
  await send(p, { chat_id: "zhangsan", reply_to: { raw: inbound.raw }, content: "the answer" });
  assert.equal(framesAfter(fake, later)[0].body.stream.id, streamId);
});

test("proactive media is uploaded and pushed without touching a stream", async (t) => {
  const { fake, p, dirs } = await env(t);
  const file = join(dirs.mediaDir, "clip.mp4");
  writeFileSync(file, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isommp41"), randomBytes(2000)]));
  const res = await send(p, { chat_id: "wrkGroup42", proactive: true, content: "weekly clip", media: { path: file, name: "clip.mp4" } });
  assert.deepEqual(res.result, {});
  const sent = framesAfter(fake, 1);
  assert.deepEqual(sent.map((f) => f.cmd), ["aibot_send_msg", "aibot_upload_media_init", "aibot_upload_media_chunk", "aibot_upload_media_finish", "aibot_send_msg"]);
  assert.deepEqual(sent[0].body, { chatid: "wrkGroup42", msgtype: "markdown", markdown: { content: "weekly clip" } });
  assert.equal(sent[1].body.type, "video");
  assert.deepEqual(sent[4].body, { chatid: "wrkGroup42", msgtype: "video", video: { media_id: "media-of-upload-1" } });
  assert.equal(fake.frames.filter((f) => f.cmd === "aibot_respond_msg").length, 0);
});

test("a reply without a usable raw is sent as a new message", async (t) => {
  const { fake, p } = await env(t);
  await send(p, { chat_id: "zhangsan", content: "no raw" });
  await send(p, { chat_id: "zhangsan", reply_to: { raw: "not json" }, content: "bad raw" });
  const sent = framesAfter(fake, 1);
  assert.deepEqual(sent.map((f) => [f.cmd, f.body.markdown.content]), [
    ["aibot_send_msg", "no raw"],
    ["aibot_send_msg", "bad raw"],
  ]);
});

test("long text is split by bytes: the stream gets the first part, the rest is pushed", async (t) => {
  const { fake, p } = await env(t);
  const { reqId, inbound, streamId } = await receive(fake, p);
  const line = "第" + "数据".repeat(999) + "\n";
  const content = line.repeat(8);
  const mark = fake.frames.length;
  await send(p, { chat_id: inbound.chat_id, reply_to: { raw: inbound.raw }, content });
  const sent = framesAfter(fake, mark);
  assert.equal(sent[0].cmd, "aibot_respond_msg");
  assert.equal(sent[0].headers.req_id, reqId);
  assert.equal(sent[0].body.stream.id, streamId);
  assert.ok(sent.length >= 3);
  const parts = [sent[0].body.stream.content];
  for (const f of sent.slice(1)) {
    assert.equal(f.cmd, "aibot_send_msg");
    assert.equal(f.body.chatid, "zhangsan");
    parts.push(f.body.markdown.content);
  }
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part) <= 20000);
    assert.ok(part.endsWith("\n"));
  }
  assert.equal(parts.join(""), content);
});

test("replies to a raw stored by the built-in channel use its req_id", async (t) => {
  const { fake, p } = await env(t, { handlers: { aibot_respond_msg: (f) => (f.headers.req_id === "legacy-fallback" ? finishRejected(f) : { headers: { req_id: f.headers.req_id }, errcode: 0 }) } });
  const legacyBody = (reqId) =>
    JSON.stringify({
      cmd: "aibot_msg_callback",
      headers: { req_id: reqId },
      body: {
        msgid: `legacy-${reqId}`,
        aibotid: BOT_ID,
        chatid: "wrkLegacyGroup",
        chattype: "group",
        from: { userid: "wangwu" },
        create_time: 1700000000,
        response_url: "https://example.invalid/r",
        msgtype: "text",
        text: { content: "old question" },
        voice: null,
        image: null,
        file: null,
        mixed: null,
        quote: null,
      },
    });
  const res = await send(p, { chat_id: "wrkLegacyGroup", session_scope: "wangwu", reply_to: { raw: legacyBody("legacy-req") }, content: "answer to old message" });
  assert.deepEqual(res.result, {});
  const reply = fake.frames.find((f) => f.cmd === "aibot_respond_msg");
  assert.equal(reply.headers.req_id, "legacy-req");
  assert.match(reply.body.stream.id, /^stream-/);
  assert.equal(reply.body.stream.finish, true);
  assert.equal(reply.body.stream.content, "answer to old message");

  await send(p, { chat_id: "wrkLegacyGroup", session_scope: "wangwu", reply_to: { raw: legacyBody("legacy-fallback") }, content: "fallback" });
  const pushed = fake.frames.find((f) => f.cmd === "aibot_send_msg");
  assert.deepEqual(pushed.body, { chatid: "wrkLegacyGroup", msgtype: "markdown", markdown: { content: "fallback" } });
});

test("send errors reach the caller", async (t) => {
  const { fake, p, dirs } = await env(t, {
    handlers: {
      aibot_upload_media_init: (f) =>
        f.body.filename === "rejected.png"
          ? { headers: { req_id: f.headers.req_id }, errcode: 40058, errmsg: "invalid total_size" }
          : { headers: { req_id: f.headers.req_id }, errcode: 0, body: { upload_id: "u-1" } },
      aibot_upload_media_finish: (f) => ({ headers: { req_id: f.headers.req_id }, errcode: 0, body: {} }),
    },
  });
  const big = join(dirs.mediaDir, "big.bin");
  writeFileSync(big, Buffer.alloc(20 * 1024 * 1024 + 1));
  const tooLarge = await send(p, { chat_id: "zhangsan", proactive: true, media: { path: big, name: "big.bin" } });
  assert.match(tooLarge.error.message, /file too large: 20971521 bytes/);

  const rejected = join(dirs.mediaDir, "rejected.png");
  writeFileSync(rejected, pngBytes(10));
  const initFailed = await send(p, { chat_id: "zhangsan", proactive: true, media: { path: rejected, name: "rejected.png" } });
  assert.equal(initFailed.error.message, "upload init: ack error: code=40058 msg=invalid total_size");

  const noMediaId = join(dirs.mediaDir, "ok.png");
  writeFileSync(noMediaId, pngBytes(10));
  const finishFailed = await send(p, { chat_id: "zhangsan", proactive: true, media: { path: noMediaId, name: "ok.png" } });
  assert.equal(finishFailed.error.message, "upload finish: no media_id in response");

  const missing = await send(p, { chat_id: "zhangsan", proactive: true, media: { path: join(dirs.mediaDir, "nope.png"), name: "nope.png" } });
  assert.match(missing.error.message, /^read media file: ENOENT/);
  assert.equal(fake.frames.filter((f) => f.cmd === "aibot_send_msg").length, 0);
});

test("sends fail while disconnected", async (t) => {
  const { fake, p } = await env(t, { timings: { reconnectBaseDelay: 5000 } });
  fake.dropAll();
  await p.waitLog((l) => l.message === "wecom connection closed");
  const res = await send(p, { chat_id: "zhangsan", proactive: true, content: "anyone?" });
  assert.equal(res.error.code, -32000);
  assert.equal(res.error.message, "send markdown message: not connected");
});

test("a cancelled send stops before the next upload step", async (t) => {
  const { fake, p, dirs } = await env(t, {
    handlers: {
      aibot_upload_media_chunk: (f) => new Promise((resolve) => setTimeout(() => resolve({ headers: { req_id: f.headers.req_id }, errcode: 0 }), 150)),
    },
  });
  const file = join(dirs.mediaDir, "big.png");
  writeFileSync(file, pngBytes(3 * 512 * 1024));
  const id = 9001;
  p.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "send", params: { session_key: "wecom:zhangsan:zhangsan", chat_id: "zhangsan", session_scope: "zhangsan", proactive: true, media: { path: file, name: "big.png" } } }) + "\n");
  await fake.waitFor((f) => f.cmd === "aibot_upload_media_chunk");
  p.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }) + "\n");
  const res = await p.waitFor((m) => m.id === id);
  assert.equal(res.error.code, -32800);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fake.frames.filter((f) => f.cmd === "aibot_upload_media_chunk").length, 1);
  assert.equal(fake.frames.filter((f) => f.cmd === "aibot_upload_media_finish" || f.cmd === "aibot_send_msg").length, 0);
});
