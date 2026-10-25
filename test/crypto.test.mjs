import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";

import { decryptFile } from "../dist/crypto.js";
import { encryptMedia } from "./fake-wecom.mjs";

test("decryptFile round-trips WeCom media", () => {
  const key = randomBytes(32);
  const plain = Buffer.from("hello, wecom media content!");
  assert.deepEqual(decryptFile(encryptMedia(plain, key), key.toString("base64")), plain);
});

test("decryptFile strips a full 32-byte padding block", () => {
  const key = randomBytes(32);
  const plain = randomBytes(32);
  const encrypted = encryptMedia(plain, key);
  assert.equal(encrypted.length, 64);
  assert.deepEqual(decryptFile(encrypted, key.toString("base64")), plain);
});

test("decryptFile accepts unpadded base64 keys", () => {
  const key = randomBytes(32);
  const plain = Buffer.from("wecom unpadded key test");
  const unpadded = key.toString("base64").replace(/=+$/, "");
  assert.deepEqual(decryptFile(encryptMedia(plain, key), unpadded), plain);
});

test("decryptFile rejects bad input", () => {
  const key = randomBytes(32);
  const b64 = key.toString("base64");
  assert.throws(() => decryptFile(Buffer.alloc(0), b64), /encrypted data is empty/);
  assert.throws(() => decryptFile(Buffer.from("somedata"), "not-valid-base64!!!"), /decode aesKey/);
  assert.throws(() => decryptFile(Buffer.alloc(32), randomBytes(16).toString("base64")), /expected 32-byte key, got 16 bytes/);
  assert.throws(() => decryptFile(Buffer.alloc(33), b64), /not a multiple of AES block size/);
});

test("decryptFile validates the padding", () => {
  const key = randomBytes(32);
  const encrypt = (padded) => {
    const c = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
    c.setAutoPadding(false);
    return Buffer.concat([c.update(padded), c.final()]);
  };
  const zeroPad = Buffer.concat([Buffer.alloc(31, 1), Buffer.from([0])]);
  assert.throws(() => decryptFile(encrypt(zeroPad), key.toString("base64")), /invalid PKCS#7 padding value: 0/);
  const tooLarge = Buffer.concat([Buffer.alloc(31, 1), Buffer.from([33])]);
  assert.throws(() => decryptFile(encrypt(tooLarge), key.toString("base64")), /invalid PKCS#7 padding value: 33/);
  const inconsistent = Buffer.concat([Buffer.alloc(28, 7), Buffer.from([1, 2, 3, 4])]);
  assert.throws(() => decryptFile(encrypt(inconsistent), key.toString("base64")), /padding bytes inconsistent/);
});
