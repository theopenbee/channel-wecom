export const OCTET_STREAM = "application/octet-stream";
const TEXT_UTF8 = "text/plain; charset=utf-8";
const SNIFF_LEN = 512;

export const CHUNK_SIZE = 512 * 1024;
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_VIDEO_SIZE = 10 * 1024 * 1024;
export const MAX_VOICE_SIZE = 2 * 1024 * 1024;
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

type Matcher = (data: Uint8Array, firstNonWS: number) => string;

const bytes = (s: string): Uint8Array => Buffer.from(s, "latin1");

function isWS(b: number): boolean {
  return b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
}

function isTT(b: number): boolean {
  return b === 0x20 || b === 0x3e;
}

function exact(signature: string, ct: string): Matcher {
  const sig = bytes(signature);
  return (data) => {
    if (data.length < sig.length) return "";
    for (let i = 0; i < sig.length; i++) if (data[i] !== sig[i]) return "";
    return ct;
  };
}

function masked(pattern: string, mask: string, ct: string, skipWS = false): Matcher {
  const pat = bytes(pattern);
  const msk = bytes(mask);
  return (input, firstNonWS) => {
    const data = skipWS ? input.subarray(firstNonWS) : input;
    if (pat.length !== msk.length || data.length < pat.length) return "";
    for (let i = 0; i < pat.length; i++) if ((data[i] & msk[i]) !== pat[i]) return "";
    return ct;
  };
}

function html(tag: string): Matcher {
  const sig = bytes(tag);
  return (input, firstNonWS) => {
    const data = input.subarray(firstNonWS);
    if (data.length < sig.length + 1) return "";
    for (let i = 0; i < sig.length; i++) {
      let db = data[i];
      if (sig[i] >= 0x41 && sig[i] <= 0x5a) db &= 0xdf;
      if (db !== sig[i]) return "";
    }
    return isTT(data[sig.length]) ? "text/html; charset=utf-8" : "";
  };
}

const mp4: Matcher = (data) => {
  if (data.length < 12) return "";
  const boxSize = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
  if (data.length < boxSize || boxSize % 4 !== 0) return "";
  if (Buffer.from(data.subarray(4, 8)).toString("latin1") !== "ftyp") return "";
  for (let st = 8; st < boxSize; st += 4) {
    if (st === 12) continue;
    if (Buffer.from(data.subarray(st, st + 3)).toString("latin1") === "mp4") return "video/mp4";
  }
  return "";
};

const text: Matcher = (data, firstNonWS) => {
  for (let i = firstNonWS; i < data.length; i++) {
    const b = data[i];
    if (b <= 0x08 || b === 0x0b || (b >= 0x0e && b <= 0x1a) || (b >= 0x1c && b <= 0x1f)) return "";
  }
  return TEXT_UTF8;
};

const signatures: Matcher[] = [
  html("<!DOCTYPE HTML"),
  html("<HTML"),
  html("<HEAD"),
  html("<SCRIPT"),
  html("<IFRAME"),
  html("<H1"),
  html("<DIV"),
  html("<FONT"),
  html("<TABLE"),
  html("<A"),
  html("<STYLE"),
  html("<TITLE"),
  html("<B"),
  html("<BODY"),
  html("<BR"),
  html("<P"),
  html("<!--"),
  masked("<?xml", "\xFF\xFF\xFF\xFF\xFF", "text/xml; charset=utf-8", true),
  exact("%PDF-", "application/pdf"),
  exact("%!PS-Adobe-", "application/postscript"),
  masked("\xFE\xFF\x00\x00", "\xFF\xFF\x00\x00", "text/plain; charset=utf-16be"),
  masked("\xFF\xFE\x00\x00", "\xFF\xFF\x00\x00", "text/plain; charset=utf-16le"),
  masked("\xEF\xBB\xBF\x00", "\xFF\xFF\xFF\x00", TEXT_UTF8),
  exact("\x00\x00\x01\x00", "image/x-icon"),
  exact("\x00\x00\x02\x00", "image/x-icon"),
  exact("BM", "image/bmp"),
  exact("GIF87a", "image/gif"),
  exact("GIF89a", "image/gif"),
  masked("RIFF\x00\x00\x00\x00WEBPVP", "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF\xFF\xFF", "image/webp"),
  exact("\x89PNG\x0D\x0A\x1A\x0A", "image/png"),
  exact("\xFF\xD8\xFF", "image/jpeg"),
  masked("FORM\x00\x00\x00\x00AIFF", "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF", "audio/aiff"),
  masked("ID3", "\xFF\xFF\xFF", "audio/mpeg"),
  masked("OggS\x00", "\xFF\xFF\xFF\xFF\xFF", "application/ogg"),
  masked("MThd\x00\x00\x00\x06", "\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF", "audio/midi"),
  masked("RIFF\x00\x00\x00\x00AVI ", "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF", "video/avi"),
  masked("RIFF\x00\x00\x00\x00WAVE", "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF", "audio/wave"),
  exact("#!AMR\n", "audio/amr"),
  mp4,
  exact("\x1A\x45\xDF\xA3", "video/webm"),
  masked("\x00".repeat(34) + "LP", "\x00".repeat(34) + "\xFF\xFF", "application/vnd.ms-fontobject"),
  exact("\x00\x01\x00\x00", "font/ttf"),
  exact("OTTO", "font/otf"),
  exact("ttcf", "font/collection"),
  exact("wOFF", "font/woff"),
  exact("wOF2", "font/woff2"),
  exact("\x1F\x8B\x08", "application/x-gzip"),
  exact("PK\x03\x04", "application/zip"),
  exact("Rar!\x1A\x07\x00", "application/x-rar-compressed"),
  exact("Rar!\x1A\x07\x01\x00", "application/x-rar-compressed"),
  exact("\x00\x61\x73\x6D", "application/wasm"),
  text,
];

export function detectContentType(input: Uint8Array): string {
  const data = input.subarray(0, SNIFF_LEN);
  let firstNonWS = 0;
  while (firstNonWS < data.length && isWS(data[firstNonWS])) firstNonWS++;
  for (const match of signatures) {
    const ct = match(data, firstNonWS);
    if (ct) return ct;
  }
  return OCTET_STREAM;
}

export function fileExtension(name: string): string {
  for (let i = name.length - 1; i >= 0 && name[i] !== "/"; i--) {
    if (name[i] === ".") return name.slice(i);
  }
  return "";
}

const mimeByExtension: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
};

export function mimeFromExtension(ext: string): string {
  return mimeByExtension[ext.toLowerCase()] ?? OCTET_STREAM;
}

export function detectMime(data: Uint8Array, fileName = ""): string {
  if (data.length >= 4 && data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) return "audio/ogg";
  if (data.length > 0) {
    const ct = detectContentType(data);
    if (ct !== OCTET_STREAM && ct !== TEXT_UTF8) return ct;
  }
  if (fileName) return mimeFromExtension(fileExtension(fileName));
  if (data.length > 0) return detectContentType(data);
  return OCTET_STREAM;
}

const extensionByMime: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/amr": ".amr",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/avi": ".avi",
  "application/pdf": ".pdf",
};

export function extensionFromMime(contentType: string): string {
  return extensionByMime[contentType.split(";")[0].trim()] ?? ".bin";
}

export type WeComMediaType = "image" | "video" | "voice" | "file";

export function resolveMediaType(mime: string, size: number): WeComMediaType {
  if (mime.startsWith("image/")) return size > MAX_IMAGE_SIZE ? "file" : "image";
  if (mime.startsWith("video/")) return size > MAX_VIDEO_SIZE ? "file" : "video";
  if (mime === "audio/amr") return size > MAX_VOICE_SIZE ? "file" : "voice";
  if (mime.startsWith("audio/")) return "file";
  if (size > MAX_FILE_SIZE) throw new Error(`file too large: ${size} bytes (max ${MAX_FILE_SIZE})`);
  return "file";
}
