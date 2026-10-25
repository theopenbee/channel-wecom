import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PendingStreams,
  buildContext,
  chatIdOf,
  cleanErrmsg,
  encodeRaw,
  fileSentText,
  generateReqId,
  parseRaw,
  splitText,
  streamBody,
  utf8PrefixLength,
} from "../dist/helpers.js";

test("generateReqId uses <prefix>-<ms>-<8 hex>", () => {
  const before = Date.now();
  const id = generateReqId("aibot_subscribe");
  const match = id.match(/^aibot_subscribe-(\d+)-([0-9a-f]{8})$/);
  assert.ok(match, id);
  assert.ok(Number(match[1]) >= before);
  const ids = new Set(Array.from({ length: 200 }, () => generateReqId("stream")));
  assert.equal(ids.size, 200);
});

test("chatIdOf uses chatid for groups and the sender otherwise", () => {
  assert.equal(chatIdOf({ chattype: "group", chatid: "wrk-group", from: { userid: "zhangsan" } }), "wrk-group");
  assert.equal(chatIdOf({ chattype: "single", chatid: "", from: { userid: "zhangsan" } }), "zhangsan");
  assert.equal(chatIdOf({ chattype: "single" }), "");
});

test("encodeRaw keeps only what the sender needs, in the legacy shape", () => {
  const body = {
    msgid: "m1",
    aibotid: "bot",
    chatid: "g1",
    chattype: "group",
    from: { userid: "u1" },
    msgtype: "text",
    text: { content: "secret text" },
    response_url: "https://example.invalid/r",
  };
  const raw = encodeRaw("req-1", body);
  assert.deepEqual(JSON.parse(raw), { headers: { req_id: "req-1" }, body: { msgid: "m1", chatid: "g1", chattype: "group", from: { userid: "u1" } } });
  assert.doesNotMatch(raw, /secret text|response_url/);
  assert.deepEqual(parseRaw(raw), { reqId: "req-1", msgId: "m1", chatId: "g1" });
  assert.deepEqual(JSON.parse(encodeRaw("r", {})), { headers: { req_id: "r" }, body: { msgid: "", chatid: "", chattype: "", from: { userid: "" } } });
});

test("parseRaw reads legacy full frames stored by the built-in channel", () => {
  const legacy = JSON.stringify({
    cmd: "aibot_msg_callback",
    headers: { req_id: "legacy-req" },
    body: {
      msgid: "legacy-msg",
      aibotid: "bot",
      chatid: "",
      chattype: "single",
      from: { userid: "lisi" },
      create_time: 1700000000,
      response_url: "",
      msgtype: "text",
      text: { content: "hi" },
      voice: null,
      image: null,
      file: null,
      mixed: null,
      quote: null,
    },
  });
  assert.deepEqual(parseRaw(legacy), { reqId: "legacy-req", msgId: "legacy-msg", chatId: "lisi" });
});

test("parseRaw rejects raws without a req_id or body", () => {
  assert.equal(parseRaw(undefined), undefined);
  assert.equal(parseRaw(""), undefined);
  assert.equal(parseRaw("not json"), undefined);
  assert.equal(parseRaw(JSON.stringify({ headers: {}, body: {} })), undefined);
  assert.equal(parseRaw(JSON.stringify({ headers: { req_id: "r" } })), undefined);
  assert.equal(parseRaw(JSON.stringify({ headers: { req_id: "r" }, body: "not-an-object" })), undefined);
});

test("buildContext reproduces the built-in ExtractContext object", () => {
  const body = { msgid: "m", aibotid: "b", chattype: "single", from: { userid: "u" }, msgtype: "text", create_time: 1 };
  assert.deepEqual(buildContext(body), { msgid: "m", aibotid: "b", chatid: "", chattype: "single", from: { userid: "u" }, msgtype: "text" });
  assert.deepEqual(buildContext({}), { msgid: "", aibotid: "", chatid: "", chattype: "", from: { userid: "" }, msgtype: "" });
  assert.equal(
    JSON.stringify(buildContext({ msgid: "m", aibotid: "b", chatid: "g", chattype: "group", from: { userid: "u" }, msgtype: "mixed" })),
    '{"msgid":"m","aibotid":"b","chatid":"g","chattype":"group","from":{"userid":"u"},"msgtype":"mixed"}',
  );
});

test("streamBody builds the stream payload", () => {
  assert.deepEqual(streamBody("s1", false, "<think></think>"), { msgtype: "stream", stream: { id: "s1", finish: false, content: "<think></think>" } });
});

test("splitText keeps chunks within the byte limit and prefers line breaks", () => {
  const line = "数据".repeat(1000) + "\n";
  const text = line.repeat(10);
  const chunks = splitText(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c) <= 20000);
    assert.ok(c.endsWith("\n"));
  }
  assert.deepEqual(splitText("short"), ["short"]);
  assert.deepEqual(splitText(""), []);
});

test("splitText cuts long lines by bytes and never splits a surrogate pair", () => {
  const text = "a".repeat(19998) + "😀" + "b".repeat(10);
  const chunks = splitText(text);
  assert.deepEqual(chunks, ["a".repeat(19998), "😀" + "b".repeat(10)]);
  const emoji = "😀".repeat(12000);
  const parts = splitText(emoji);
  assert.equal(parts.join(""), emoji);
  for (const p of parts) {
    assert.ok(Buffer.byteLength(p) <= 20000);
    assert.doesNotMatch(p, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
});

test("utf8PrefixLength counts UTF-8 bytes", () => {
  assert.equal(utf8PrefixLength("abc", 2), 2);
  assert.equal(utf8PrefixLength("é", 1), 1);
  assert.equal(utf8PrefixLength("中文", 5), 1);
  assert.equal(utf8PrefixLength("😀x", 4), 2);
  assert.equal(utf8PrefixLength("😀x", 3), 2);
});

test("cleanErrmsg drops the hint and ip noise", () => {
  assert.equal(
    cleanErrmsg("invalid bot_id or secret, hint: [1761_abc], from ip: 1.2.3.4, more info at https://open.work.weixin.qq.com/devtool/query?e=853000"),
    "invalid bot_id or secret",
  );
  assert.equal(cleanErrmsg("ok"), "ok");
});

test("fileSentText is localized", () => {
  assert.equal(fileSentText("zh"), "📎 文件已发送，请查收。");
  assert.equal(fileSentText("en"), "📎 File sent, please check.");
  assert.equal(fileSentText("fr"), "📎 File sent, please check.");
});

test("PendingStreams hands out a stream once and expires it", async () => {
  const streams = new PendingStreams(30);
  streams.set("m1", "s1");
  assert.equal(streams.take("m1"), "s1");
  assert.equal(streams.take("m1"), undefined);
  streams.set("m2", "s2");
  streams.set("", "ignored");
  assert.equal(streams.size, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(streams.take("m2"), undefined);
  streams.set("m3", "s3");
  streams.clear();
  assert.equal(streams.size, 0);
});
