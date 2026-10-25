export const CMD_SUBSCRIBE = "aibot_subscribe";
export const CMD_HEARTBEAT = "ping";
export const CMD_CALLBACK = "aibot_msg_callback";
export const CMD_EVENT_CALLBACK = "aibot_event_callback";
export const CMD_RESPOND = "aibot_respond_msg";
export const CMD_SEND_MSG = "aibot_send_msg";
export const CMD_UPLOAD_INIT = "aibot_upload_media_init";
export const CMD_UPLOAD_CHUNK = "aibot_upload_media_chunk";
export const CMD_UPLOAD_FINISH = "aibot_upload_media_finish";

export const ERRCODE_INVALID_CREDENTIALS = 853000;

export interface WsFrame {
  cmd?: string;
  headers: { req_id: string };
  body?: unknown;
  errcode?: number;
  errmsg?: string;
}

export interface TextContent {
  content?: string;
}

export interface EncryptedMedia {
  url?: string;
  aeskey?: string;
}

export interface MixedItem {
  msgtype?: string;
  text?: TextContent;
  image?: EncryptedMedia;
}

export interface MixedContent {
  msg_item?: MixedItem[];
}

export interface QuoteContent {
  msgtype?: string;
  text?: TextContent;
  voice?: TextContent;
  image?: EncryptedMedia;
  file?: EncryptedMedia;
  mixed?: MixedContent;
}

export interface MessageBody {
  msgid?: string;
  aibotid?: string;
  chatid?: string;
  chattype?: string;
  from?: { userid?: string };
  create_time?: number;
  response_url?: string;
  msgtype?: string;
  text?: TextContent;
  voice?: TextContent;
  image?: EncryptedMedia;
  file?: EncryptedMedia;
  mixed?: MixedContent;
  quote?: QuoteContent;
}

export interface StreamBody {
  msgtype: "stream";
  stream: { id: string; finish: boolean; content: string };
}
