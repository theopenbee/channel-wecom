import { createDecipheriv } from "node:crypto";

const AES_BLOCK_SIZE = 16;
const WECOM_PAD_BLOCK = 32;

function decodeRawStdBase64(input: string): Buffer {
  const cleaned = input.replace(/[\r\n]/g, "");
  if (!/^[A-Za-z0-9+/]*$/.test(cleaned) || cleaned.length % 4 === 1) {
    throw new Error("illegal base64 data");
  }
  return Buffer.from(cleaned, "base64");
}

export function decryptFile(encrypted: Uint8Array, aesKeyBase64: string): Buffer {
  if (encrypted.length === 0) throw new Error("decryptFile: encrypted data is empty");
  let key: Buffer;
  try {
    key = decodeRawStdBase64(aesKeyBase64.replace(/=+$/, ""));
  } catch (err) {
    throw new Error(`decryptFile: decode aesKey: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (key.length !== 32) throw new Error(`decryptFile: expected 32-byte key, got ${key.length} bytes`);
  if (encrypted.length % AES_BLOCK_SIZE !== 0) {
    throw new Error(`decryptFile: ciphertext length ${encrypted.length} is not a multiple of AES block size`);
  }
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const padLen = decrypted[decrypted.length - 1];
  if (padLen < 1 || padLen > WECOM_PAD_BLOCK || padLen > decrypted.length) {
    throw new Error(`decryptFile: invalid PKCS#7 padding value: ${padLen}`);
  }
  for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
    if (decrypted[i] !== padLen) throw new Error("decryptFile: PKCS#7 padding bytes inconsistent");
  }
  return decrypted.subarray(0, decrypted.length - padLen);
}
