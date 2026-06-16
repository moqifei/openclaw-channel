import type { ApiService, CallbackEvent, MessageItem } from "@openim/client-sdk";

export type ChatType = "direct" | "group";

export interface OpenIMAccountConfig {
  accountId: string;
  enabled: boolean;
  userID: string;
  token?: string;
  wsAddr: string;
  apiAddr: string;
  platformID: number;
  adminSecret: string;
  adminUserID: string;
  chatApiAddr?: string;
  chatToken?: string;
  requireMention: boolean;
  processOfflineMessages: boolean;
  inboundWhitelist: string[];
}

export interface OpenIMClientState {
  sdk: ApiService;
  config: OpenIMAccountConfig;
  messageAcceptAfterMs: number;
  replayFilterUntilMs: number;
  handlers: {
    onRecvNewMessage: (event: CallbackEvent<MessageItem>) => void;
    onRecvNewMessages: (event: CallbackEvent<MessageItem[]>) => void;
    onRecvOfflineNewMessages: (event: CallbackEvent<MessageItem[]>) => void;
    onUserTokenExpired?: (event: CallbackEvent<unknown>) => void;
    onUserTokenInvalid?: (event: CallbackEvent<unknown>) => void;
    onKickedOffline?: (event: CallbackEvent<unknown>) => void;
    onConnectFailed?: (event: CallbackEvent<unknown>) => void;
    onConnectSuccess?: (event: CallbackEvent<unknown>) => void;
  };
  reconnect?: {
    timer?: ReturnType<typeof setTimeout>;
    attempts: number;
    running: boolean;
    stopped: boolean;
  };
}

export interface ParsedTarget {
  kind: "user" | "group";
  id: string;
}

export interface InboundMediaItem {
  kind: "image" | "video" | "file";
  url?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  snapshotUrl?: string;
}

export interface InboundBodyResult {
  body: string;
  kind: "text" | "image" | "video" | "file" | "mixed" | "unknown";
  media?: InboundMediaItem[];
}
