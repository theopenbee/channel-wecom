# openbee WeCom channel

WeCom (企业微信) AI bot channel for openbee, built on [`@theopenbee/channel-sdk`](https://www.npmjs.com/package/@theopenbee/channel-sdk). It replaces the WeCom channel that used to be built into openbee and keeps its config and session keys.

## Behaviour

- Uses the AI bot long connection (WebSocket), so openbee needs no public address or callback URL. A heartbeat runs every 30 seconds; after a dropped connection the plugin reconnects and subscribes again, waiting 1 s, doubling up to 30 s, for as long as it takes.
- Private and group chats. One openbee session per chat and user (`wecom:<chat>:<user>`, where the chat is the group's `chatid` or the user's `userid` in private chats), as before.
- As soon as a message arrives the bot shows an empty "thinking" stream; the reply completes that stream. Open streams are kept in the plugin data directory, so a reply sent after openbee restarts still completes them. Streams nobody answers are forgotten after 10 minutes.
- Text, voice (WeCom's transcript), images, files and mixed text-and-image messages are handled. Quoted messages are appended: their text after the message text, their images and files after the message's own. Media up to 100 MiB is downloaded, decrypted with the message's AES key and saved into openbee's media directory, with the file type detected from the content.
- If WeCom refuses the stream reply (for example because the reply window has passed), the text is sent as a new markdown message instead. Scheduled results and other proactive messages are sent as markdown messages to the chat.
- Text longer than 20,000 bytes is split, preferring line breaks; the first part completes the stream, the rest follows as markdown messages. Text is sent first, then the file.
- Files are uploaded in 512 KiB chunks. Images and videos up to 10 MB are sent as images and videos, AMR audio up to 2 MB as voice, everything else as a file (at most 20 MB). A reply that consists of a file only completes the stream with "📎 File sent, please check." (or the Chinese text when openbee runs in Chinese).
- WeCom delivers a bot's messages to one connection only. If another process subscribes with the same bot, the plugin logs a warning.
- `HTTPS_PROXY` and `HTTP_PROXY` are not used; the plugin connects to WeCom directly.

## Create the bot

1. In the [WeCom admin console](https://work.weixin.qq.com/), open the AI bot (智能机器人) page and create a bot in API mode (API 模式创建).
2. Choose the long connection (长连接) as connection method. No callback URL, IP allowlist or event subscription is needed.
3. Copy the **Bot ID** and **Secret**.
4. Add the bot to group chats, or open it in WeCom to chat privately. In groups, members @mention the bot.

## Install

```sh
openbee plugin install @theopenbee/channel-wecom
```

Or from a local checkout:

```sh
git clone https://github.com/theopenbee/channel-wecom.git
cd channel-wecom
npm install
openbee plugin install "$(pwd)"
```

Then enable it with `openbee config`, or add it to `config.yaml` and restart openbee. A config written for the built-in channel works unchanged:

```yaml
bee:
  platforms:
    wecom:
      enabled: true
      bot_name: OpenBee
      bot_id: "<bot id>"
      secret: "<secret>"
```

| Key | Default | |
|---|---|---|
| `bot_id` | | Bot ID of the AI bot. Required. |
| `secret` | | Secret of the AI bot. Required. |
| `websocket_url` | `wss://openws.work.weixin.qq.com` | Long-connection endpoint. Change only for a proxy or a test server. |

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`.
