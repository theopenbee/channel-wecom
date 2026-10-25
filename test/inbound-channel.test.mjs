import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { BOT_ID, encryptMedia, pngBytes, startFakeWeCom, startMediaServer } from "./fake-wecom.mjs";
import { initialized } from "./harness.mjs";

let seq = 0;
function body(overrides = {}) {
  seq += 1;
  return {
    msgid: `msg-${seq}`,
    aibotid: BOT_ID,
    chattype: "single",
    from: { userid: "zhangsan" },
    create_time: 1761300000 + seq,
    response_url: "https://example.invalid/response",
    msgtype: "text",
    text: { content: "hello" },
    ...overrides,
  };
}

async function env(t) {
  const fake = await startFakeWeCom();
  const media = await startMediaServer();
  t.after(async () => {
    await fake.close();
    await media.close();
  });
  const { p, dirs } = await initialized(t, fake);
  return { fake, media, p, dirs };
}

function encrypted(media, path, plain) {
  const key = randomBytes(32);
  return { url: media.add(path, encryptMedia(plain, key)), aeskey: key.toString("base64").replace(/=+$/, "") };
}

function assertSaved(att, dirs, type, ext, content) {
  assert.equal(att.type, type);
  assert.equal(dirname(att.path), dirs.mediaDir);
  assert.ok(att.path.endsWith(ext), att.path);
  assert.deepEqual(readFileSync(att.path), content);
}

test("text messages get a thinking stream, then reach openbee", async (t) => {
  const { fake, p } = await env(t);
  const b = body({ text: { content: "@Bee hello there" } });
  const reqId = fake.callback(b);
  const inbound = await p.waitInbound((m) => m.message_id === b.msgid);
  const thinking = fake.frames.find((f) => f.cmd === "aibot_respond_msg" && f.headers.req_id === reqId);
  assert.ok(thinking, "thinking stream must be sent before dispatch");
  assert.equal(thinking.body.msgtype, "stream");
  assert.equal(thinking.body.stream.finish, false);
  assert.equal(thinking.body.stream.content, "<think></think>");
  assert.match(thinking.body.stream.id, /^stream-\d+-[0-9a-f]{8}$/);
  assert.deepEqual(inbound, {
    chat_id: "zhangsan",
    sender_id: "zhangsan",
    message_id: b.msgid,
    text: "@Bee hello there",
    attachments: [],
    raw: JSON.stringify({ headers: { req_id: reqId }, body: { msgid: b.msgid, chatid: "", chattype: "single", from: { userid: "zhangsan" } } }),
    context: { msgid: b.msgid, aibotid: BOT_ID, chatid: "", chattype: "single", from: { userid: "zhangsan" }, msgtype: "text" },
    time: b.create_time * 1000,
  });
});

test("group messages use the group chat id and voice uses its transcript", async (t) => {
  const { fake, p } = await env(t);
  const g = body({ chattype: "group", chatid: "wrkGroup42", from: { userid: "lisi" }, text: { content: "group message" } });
  fake.callback(g);
  const v = body({ msgtype: "voice", text: undefined, voice: { content: "transcribed text" } });
  fake.callback(v);
  const group = await p.waitInbound((m) => m.message_id === g.msgid);
  assert.equal(group.chat_id, "wrkGroup42");
  assert.equal(group.sender_id, "lisi");
  assert.equal(group.session_scope, undefined);
  assert.equal(group.context.chatid, "wrkGroup42");
  assert.equal(group.context.chattype, "group");
  assert.equal(JSON.parse(group.raw).body.chatid, "wrkGroup42");
  const voice = await p.waitInbound((m) => m.message_id === v.msgid);
  assert.equal(voice.text, "transcribed text");
  assert.equal(voice.context.msgtype, "voice");
});

test("images and files are downloaded, decrypted and sniffed", async (t) => {
  const { fake, media, p, dirs } = await env(t);
  const png = pngBytes(5000);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(3000)]);
  const plain = Buffer.from("no key, no encryption");
  const img = body({ msgtype: "image", text: undefined, image: encrypted(media, "/img", png) });
  const file = body({ msgtype: "file", text: undefined, file: encrypted(media, "/doc", pdf) });
  const raw = body({ msgtype: "file", text: undefined, file: { url: media.add("/plain", plain), aeskey: "" } });
  fake.callback(img);
  fake.callback(file);
  fake.callback(raw);
  const i = await p.waitInbound((m) => m.message_id === img.msgid);
  assert.equal(i.text, "");
  assert.equal(i.attachments.length, 1);
  assertSaved(i.attachments[0], dirs, "image", ".png", png);
  assert.equal(i.attachments[0].name, undefined);
  const f = await p.waitInbound((m) => m.message_id === file.msgid);
  assertSaved(f.attachments[0], dirs, "document", ".pdf", pdf);
  const r = await p.waitInbound((m) => m.message_id === raw.msgid);
  assertSaved(r.attachments[0], dirs, "document", ".bin", plain);
});

test("failed downloads keep an attachment without a path", async (t) => {
  const { fake, media, p } = await env(t);
  const missing = body({ msgtype: "image", text: undefined, image: { url: media.url("/gone"), aeskey: randomBytes(32).toString("base64") } });
  const wrongKey = body({ msgtype: "file", text: undefined, file: { url: media.add("/x", encryptMedia(pngBytes(100), randomBytes(32))), aeskey: randomBytes(16).toString("base64") } });
  const noObject = body({ msgtype: "image", text: undefined });
  const noUrl = body({ msgtype: "file", text: undefined, file: { url: "", aeskey: "" } });
  for (const b of [missing, wrongKey, noObject, noUrl]) fake.callback(b);
  assert.deepEqual((await p.waitInbound((m) => m.message_id === missing.msgid)).attachments, [{ type: "image", path: "" }]);
  assert.deepEqual((await p.waitInbound((m) => m.message_id === wrongKey.msgid)).attachments, [{ type: "document", path: "" }]);
  assert.deepEqual((await p.waitInbound((m) => m.message_id === noObject.msgid)).attachments, [{ type: "image", path: "" }]);
  assert.deepEqual((await p.waitInbound((m) => m.message_id === noUrl.msgid)).attachments, [{ type: "document", path: "" }]);
  const errors = p.logs("error").filter((l) => l.message === "wecom media download failed");
  assert.equal(errors.length, 2);
  assert.match(errors[0].fields.error + errors[1].fields.error, /HTTP 404/);
  assert.match(errors[0].fields.error + errors[1].fields.error, /decryptFile: expected 32-byte key/);
});

test("mixed messages join texts and download images in order", async (t) => {
  const { fake, media, p, dirs } = await env(t);
  const first = pngBytes(2000);
  const second = Buffer.concat([Buffer.from("GIF89a"), randomBytes(500)]);
  const m = body({
    msgtype: "mixed",
    text: undefined,
    mixed: {
      msg_item: [
        { msgtype: "text", text: { content: "look at this:" } },
        { msgtype: "image", image: encrypted(media, "/m1", first) },
        { msgtype: "text", text: { content: "and this" } },
        { msgtype: "image", image: encrypted(media, "/m2", second) },
      ],
    },
  });
  fake.callback(m);
  const inbound = await p.waitInbound((x) => x.message_id === m.msgid);
  assert.equal(inbound.text, "look at this:\nand this");
  assert.equal(inbound.attachments.length, 2);
  assertSaved(inbound.attachments[0], dirs, "image", ".png", first);
  assertSaved(inbound.attachments[1], dirs, "image", ".gif", second);
  assert.equal(inbound.context.msgtype, "mixed");
});

test("quoted text and media follow the message's own content", async (t) => {
  const { fake, media, p, dirs } = await env(t);
  const quotedPdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(100)]);
  const textQuote = body({ text: { content: "my reply" }, quote: { msgtype: "text", text: { content: "quoted original" } } });
  const fileQuote = body({ text: { content: "see attached" }, quote: { msgtype: "file", file: encrypted(media, "/q", quotedPdf) } });
  const own = pngBytes(300);
  const quotedImage = pngBytes(400);
  const imageQuote = body({
    msgtype: "image",
    text: undefined,
    image: encrypted(media, "/own", own),
    quote: { msgtype: "mixed", mixed: { msg_item: [{ msgtype: "text", text: { content: "earlier" } }, { msgtype: "image", image: encrypted(media, "/old", quotedImage) }] } },
  });
  for (const b of [textQuote, fileQuote, imageQuote]) fake.callback(b);
  assert.equal((await p.waitInbound((m) => m.message_id === textQuote.msgid)).text, "my reply\nquoted original");
  const f = await p.waitInbound((m) => m.message_id === fileQuote.msgid);
  assert.equal(f.text, "see attached");
  assertSaved(f.attachments[0], dirs, "document", ".pdf", quotedPdf);
  const i = await p.waitInbound((m) => m.message_id === imageQuote.msgid);
  assert.equal(i.text, "earlier");
  assertSaved(i.attachments[0], dirs, "image", ".png", own);
  assertSaved(i.attachments[1], dirs, "image", ".png", quotedImage);
});

test("unsupported and empty messages are skipped without a thinking stream", async (t) => {
  const { fake, p } = await env(t);
  const link = body({ msgtype: "link", text: undefined });
  const empty = body({ text: { content: "" } });
  const noText = body({ text: undefined });
  const linkReq = fake.callback(link);
  const emptyReq = fake.callback(empty);
  const noTextReq = fake.callback(noText);
  const after = body({ text: { content: "next" } });
  fake.callback(after);
  await p.waitInbound((m) => m.message_id === after.msgid);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(p.inbound().map((m) => m.message_id), [after.msgid]);
  const responded = fake.frames.filter((f) => f.cmd === "aibot_respond_msg").map((f) => f.headers.req_id);
  for (const req of [linkReq, emptyReq, noTextReq]) assert.ok(!responded.includes(req));
  const warn = p.logs("warn").find((l) => l.message === "wecom: skipping unsupported msgtype");
  assert.deepEqual(warn.fields, { msgtype: "link" });
});

test("a failed thinking stream does not block the message", async (t) => {
  const fake = await startFakeWeCom({ aibot_respond_msg: (f) => ({ headers: { req_id: f.headers.req_id }, errcode: 846605, errmsg: "invalid req_id" }) });
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  const b = body();
  fake.callback(b);
  await p.waitInbound((m) => m.message_id === b.msgid);
  const warn = p.logs("warn").find((l) => l.message === "wecom: failed to send thinking message");
  assert.match(warn.fields.error, /ack error: code=846605 msg=invalid req_id/);
});
