import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { BOT_ID, SECRET } from "./fake-wecom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mainEntry = join(here, "..", "dist", "index.js");
const fastEntry = join(here, "fast-entry.mjs");

export function startPlugin(home, timings) {
  const args = timings ? [fastEntry, JSON.stringify(timings)] : [mainEntry];
  const child = spawn(process.execPath, args, { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  let nextId = 1;
  return {
    child,
    exited,
    messages,
    stderr: () => stderr,
    logs: (level) => messages.filter((m) => m.method === "log" && (!level || m.params.level === level)).map((m) => m.params),
    inbound: () => messages.filter((m) => m.method === "inbound").map((m) => m.params),
    waitFor(match, ms = 5000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; stderr: ${stderr}`)), ms);
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    request(method, params, ms) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return this.waitFor((m) => m.id === id, ms);
    },
    waitInbound(match = () => true, ms) {
      return this.waitFor((m) => m.method === "inbound" && match(m.params), ms).then((m) => m.params);
    },
    waitLog(match, ms) {
      return this.waitFor((m) => m.method === "log" && match(m.params), ms).then((m) => m.params);
    },
  };
}

export function setup() {
  return {
    home: mkdtempSync(join(tmpdir(), "wecom-home-")),
    dataDir: mkdtempSync(join(tmpdir(), "wecom-data-")),
    mediaDir: mkdtempSync(join(tmpdir(), "wecom-media-")),
  };
}

export async function initialized(t, fake, { config = {}, language = "en", timings, dirs = setup() } = {}) {
  const p = startPlugin(dirs.home, timings);
  t.after(async () => {
    p.child.stdin.end();
    await p.exited;
  });
  const res = await p.request(
    "initialize",
    {
      protocol_version: 1,
      openbee_version: "test",
      channel_id: "wecom",
      language,
      bot_name: "Bee",
      config: { bot_id: BOT_ID, secret: SECRET, websocket_url: fake.url, ...config },
      data_dir: dirs.dataDir,
      media_dir: dirs.mediaDir,
    },
    15000,
  );
  return { p, res, dirs };
}

export function send(p, params, ms) {
  return p.request("send", { session_key: `wecom:${params.chat_id}:${params.session_scope ?? params.chat_id}`, session_scope: params.chat_id, proactive: false, ...params }, ms);
}
