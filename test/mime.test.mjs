import { test } from "node:test";
import assert from "node:assert/strict";

import { detectContentType, detectMime, extensionFromMime, fileExtension, mimeFromExtension, resolveMediaType } from "../dist/mime.js";

const b = (s) => Buffer.from(s, "latin1");

test("detectContentType sniffs common signatures like Go", () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), b("ftypisom"), Buffer.from([0, 0, 2, 0]), b("isommp41"), Buffer.alloc(16)]);
  const cases = [
    [b("\x89PNG\r\n\x1a\nrest"), "image/png"],
    [b("\xFF\xD8\xFF\xE0rest"), "image/jpeg"],
    [b("GIF89a...."), "image/gif"],
    [b("GIF87a...."), "image/gif"],
    [b("RIFF\x10\x00\x00\x00WEBPVP8 "), "image/webp"],
    [b("BM\x00\x00"), "image/bmp"],
    [b("\x00\x00\x01\x00\x01\x00"), "image/x-icon"],
    [b("%PDF-1.7\n"), "application/pdf"],
    [b("PK\x03\x04\x14\x00"), "application/zip"],
    [b("\x1F\x8B\x08\x00"), "application/x-gzip"],
    [b("ID3\x04\x00"), "audio/mpeg"],
    [b("RIFF\x10\x00\x00\x00WAVEfmt "), "audio/wave"],
    [b("RIFF\x10\x00\x00\x00AVI LIST"), "video/avi"],
    [b("#!AMR\n\x3c\x91"), "audio/amr"],
    [b("\x1A\x45\xDF\xA3\x01"), "video/webm"],
    [mp4, "video/mp4"],
    [b("  <!DOCTYPE html><html>"), "text/html; charset=utf-8"],
    [b("<?xml version='1.0'?>"), "text/xml; charset=utf-8"],
    [b("plain words\n"), "text/plain; charset=utf-8"],
    [b("\xEF\xBB\xBFhello"), "text/plain; charset=utf-8"],
    [Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]), "application/octet-stream"],
  ];
  for (const [data, want] of cases) assert.equal(detectContentType(data), want, data.toString("latin1"));
});

test("detectMime prefers OggS, then content, then the file extension", () => {
  assert.equal(detectMime(b("OggS\x00\x02rest")), "audio/ogg");
  assert.equal(detectMime(b("\x89PNG\r\n\x1a\nrest"), "photo.jpg"), "image/png");
  assert.equal(detectMime(b("plain text"), "notes.pdf"), "application/pdf");
  assert.equal(detectMime(Buffer.from([0, 1, 2, 3, 4]), "clip.MP4"), "video/mp4");
  assert.equal(detectMime(Buffer.from([0, 1, 2, 3, 4]), "archive.7z"), "application/octet-stream");
  assert.equal(detectMime(b("plain text")), "text/plain; charset=utf-8");
  assert.equal(detectMime(Buffer.alloc(0), "a.png"), "image/png");
  assert.equal(detectMime(Buffer.alloc(0)), "application/octet-stream");
});

test("fileExtension follows Go filepath.Ext", () => {
  assert.equal(fileExtension("report.final.pdf"), ".pdf");
  assert.equal(fileExtension("dir.d/file"), "");
  assert.equal(fileExtension(".bashrc"), ".bashrc");
  assert.equal(fileExtension("noext"), "");
  assert.equal(mimeFromExtension(".JPEG"), "image/jpeg");
});

test("extensionFromMime maps known types and defaults to .bin", () => {
  assert.equal(extensionFromMime("image/png"), ".png");
  assert.equal(extensionFromMime("image/jpeg"), ".jpg");
  assert.equal(extensionFromMime("audio/ogg"), ".ogg");
  assert.equal(extensionFromMime("audio/wave"), ".wav");
  assert.equal(extensionFromMime("audio/amr"), ".amr");
  assert.equal(extensionFromMime("video/avi"), ".avi");
  assert.equal(extensionFromMime("application/pdf"), ".pdf");
  assert.equal(extensionFromMime("text/plain; charset=utf-8"), ".bin");
  assert.equal(extensionFromMime("application/zip"), ".bin");
});

test("resolveMediaType applies the WeCom size limits", () => {
  const MiB = 1024 * 1024;
  assert.equal(resolveMediaType("image/png", 10 * MiB), "image");
  assert.equal(resolveMediaType("image/png", 10 * MiB + 1), "file");
  assert.equal(resolveMediaType("video/mp4", 10 * MiB), "video");
  assert.equal(resolveMediaType("video/mp4", 10 * MiB + 1), "file");
  assert.equal(resolveMediaType("audio/amr", 2 * MiB), "voice");
  assert.equal(resolveMediaType("audio/amr", 2 * MiB + 1), "file");
  assert.equal(resolveMediaType("audio/mpeg", 1024), "file");
  assert.equal(resolveMediaType("application/pdf", 20 * MiB), "file");
  assert.throws(() => resolveMediaType("application/pdf", 20 * MiB + 1), /file too large: 20971521 bytes \(max 20971520\)/);
});
