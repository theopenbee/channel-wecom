import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { extractContent, fetchMedia } from "../dist/inbound.js";

function stubDownloader() {
  const calls = [];
  const download = async (media, kind) => {
    calls.push({ ...media, kind });
    return { type: kind, path: media.url ? `/media/${media.url}` : "" };
  };
  return { calls, download };
}

test("text and voice become text", async () => {
  const { download } = stubDownloader();
  assert.deepEqual(await extractContent({ msgtype: "text", text: { content: "hello" } }, download), { text: "hello", attachments: [] });
  assert.deepEqual(await extractContent({ msgtype: "voice", voice: { content: "transcribed" } }, download), { text: "transcribed", attachments: [] });
  assert.deepEqual(await extractContent({ msgtype: "text", text: { content: "" } }, download), { text: "", attachments: [] });
  assert.equal(await extractContent({ msgtype: "text" }, download), undefined);
  assert.equal(await extractContent({ msgtype: "voice", voice: null }, download), undefined);
  assert.equal(await extractContent({ msgtype: "link" }, download), undefined);
});

test("image and file become attachments; a missing object keeps an empty path", async () => {
  const { calls, download } = stubDownloader();
  assert.deepEqual(await extractContent({ msgtype: "image", image: { url: "i", aeskey: "k" } }, download), {
    text: "",
    attachments: [{ type: "image", path: "/media/i" }],
  });
  assert.deepEqual(await extractContent({ msgtype: "file", file: { url: "f", aeskey: "k2" } }, download), {
    text: "",
    attachments: [{ type: "document", path: "/media/f" }],
  });
  assert.deepEqual(calls, [
    { url: "i", aeskey: "k", kind: "image" },
    { url: "f", aeskey: "k2", kind: "document" },
  ]);
  assert.deepEqual(await extractContent({ msgtype: "image", quote: { msgtype: "text", text: { content: "q" } } }, download), {
    text: "",
    attachments: [{ type: "image", path: "" }],
  });
  assert.deepEqual(await extractContent({ msgtype: "file" }, download), { text: "", attachments: [{ type: "document", path: "" }] });
});

test("mixed joins texts and keeps image order", async () => {
  const { download } = stubDownloader();
  const body = {
    msgtype: "mixed",
    mixed: {
      msg_item: [
        { msgtype: "text", text: { content: "look at this:" } },
        { msgtype: "image", image: { url: "a", aeskey: "k" } },
        { msgtype: "text", text: { content: "" } },
        { msgtype: "image" },
        { msgtype: "text", text: { content: "and this" } },
        { msgtype: "image", image: { url: "b", aeskey: "k" } },
      ],
    },
  };
  assert.deepEqual(await extractContent(body, download), {
    text: "look at this:\nand this",
    attachments: [
      { type: "image", path: "/media/a" },
      { type: "image", path: "/media/b" },
    ],
  });
  assert.equal(await extractContent({ msgtype: "mixed" }, download), undefined);
});

test("quotes append text and media after the message's own", async () => {
  const { download } = stubDownloader();
  assert.deepEqual(await extractContent({ msgtype: "text", text: { content: "my reply" }, quote: { msgtype: "text", text: { content: "quoted original" } } }, download), {
    text: "my reply\nquoted original",
    attachments: [],
  });
  assert.deepEqual(await extractContent({ msgtype: "text", text: { content: "see attached" }, quote: { msgtype: "file", file: { url: "q", aeskey: "k" } } }, download), {
    text: "see attached",
    attachments: [{ type: "document", path: "/media/q" }],
  });
  assert.deepEqual(
    await extractContent(
      {
        msgtype: "image",
        image: { url: "own", aeskey: "k" },
        quote: { msgtype: "mixed", mixed: { msg_item: [{ msgtype: "text", text: { content: "old" } }, { msgtype: "image", image: { url: "old", aeskey: "k" } }] } },
      },
      download,
    ),
    { text: "old", attachments: [{ type: "image", path: "/media/own" }, { type: "image", path: "/media/old" }] },
  );
  assert.deepEqual(await extractContent({ msgtype: "text", text: { content: "x" }, quote: { msgtype: "voice", voice: { content: "said" } } }, download), {
    text: "x\nsaid",
    attachments: [],
  });
  assert.deepEqual(await extractContent({ msgtype: "text", text: { content: "x" }, quote: { msgtype: "image" } }, download), { text: "x", attachments: [] });
  assert.deepEqual(await extractContent({ msgtype: "text", text: { content: "" }, quote: { msgtype: "text", text: { content: "only quote" } } }, download), {
    text: "only quote",
    attachments: [],
  });
});

test("fetchMedia enforces status and size", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/ok") return res.end(Buffer.alloc(100, 1));
    if (req.url === "/big") return res.end(Buffer.alloc(5000, 1));
    res.writeHead(403);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetchMedia(`${base}/ok`, 1000, 5000)).length, 100);
  await assert.rejects(fetchMedia(`${base}/big`, 1000, 5000), /download too large/);
  await assert.rejects(fetchMedia(`${base}/nope`, 1000, 5000), /HTTP 403/);
});
