import { connectedClientCount, getConnectedClient, startAccountClient, stopAllClients } from "./clients";
import { getOpenIMAccountConfig, listAccountIds, resolveAccountConfig } from "./config";
import { OpenIMDigitalTwinProtocol } from "./digital-twin";
import { sendTextToTarget } from "./media";
import { parseTarget } from "./targets";
import { formatSdkError } from "./utils";
import { isPipeBrokenError, markStdoutBroken, scheduleStdoutBrokenExit, updateLastFlush } from "./liveness";

/** 模块级 logger，由 gateway.startAccount 注册，供 outbound 等无 logger 句柄的入口使用。 */
let channelLogger: any = undefined;

/**
 * 把结构化内容（orange 的 `blocks`）拍平成 OpenIM 可承载的文本。
 *
 * orange 的 `send_outbound_post` 会把富文本（如飞书 post JSON）放进 `blocks`
 * 并把 `text` 置空；本渠道目前只承载文本，若直接忽略 `blocks`，收件人将收到
 * 一条**空消息**。因此这里做保守拍平：能识别的形状还原为可读文本，识别不了则
 * 记警告并回退到 `text`。
 */
export function renderOutboundBody(text?: string, blocks?: unknown): string {
  const flattened = flattenBlocks(blocks);
  if (flattened) return flattened;
  if (blocks !== undefined && blocks !== null && !flattened) {
    channelLogger?.warn?.(
      `[openim] outbound: could not render blocks to text; falling back to text (blocksType=${typeof blocks})`,
    );
  }
  return text ?? "";
}

function flattenBlocks(blocks: unknown): string {
  if (blocks === undefined || blocks === null) return "";
  if (Array.isArray(blocks)) return renderContent(blocks);
  if (typeof blocks === "object") {
    const node = blocks as Record<string, unknown>;
    // 飞书 post 形状：{ zh_cn: { content: [[{ tag: "text", text: "..." }]] } }
    for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
      const rendered = renderContent((node[locale] as Record<string, unknown> | undefined)?.content);
      if (rendered) return rendered;
    }
    return renderContent(node.content ?? node.blocks);
  }
  if (typeof blocks === "string") return blocks;
  return "";
}

/** 把 content（可能是 [[node]] 或 [node]）渲染为多行文本。 */
function renderContent(content: unknown): string {
  if (!content) return "";
  const rows = Array.isArray(content) ? content : [content];
  const lines: string[] = [];
  for (const row of rows) {
    const line = renderInline(Array.isArray(row) ? row : [row]);
    if (line) lines.push(line);
  }
  return lines.join("\n").trim();
}

function renderInline(nodes: unknown[]): string {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      out += node;
    } else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (typeof record.text === "string") out += record.text;
      else if (typeof record.content === "string") out += record.content;
    }
  }
  return out;
}

export const OpenIMChannelPlugin = {
  id: "openim",
  meta: {
    id: "openim",
    label: "OpenIM",
    selectionLabel: "OpenIM",
    docsPath: "/channels/openim",
    blurb: "OpenIM protocol channel via @openim/client-sdk",
    aliases: ["openim", "im"],
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    digitalTwin: OpenIMDigitalTwinProtocol,
  },
  config: {
    listAccountIds: (cfg: any) => listAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string) => resolveAccountConfig(cfg, accountId),
  },
  outbound: {
    deliveryMode: "direct" as const,
    resolveTarget: ({ to }: { to?: string }) => {
      const target = parseTarget(to);
      if (!target) {
        return { ok: false, error: new Error("OpenIM requires --to <user:ID|group:ID>") };
      }
      return { ok: true, to: `${target.kind}:${target.id}` };
    },
    sendText: async ({
      to,
      text,
      accountId,
      blocks,
    }: {
      to: string;
      text: string;
      accountId?: string;
      blocks?: unknown;
    }) => {
      const target = parseTarget(to);
      if (!target) {
        return { ok: false, error: new Error("invalid target, expected user:<id> or group:<id>") };
      }
      // 富文本（blocks）优先：否则 post 内容会被当作空 text 发出去。
      const body = renderOutboundBody(text, blocks);
      const client = getConnectedClient(accountId);
      if (!client) {
        channelLogger?.warn?.(`[openim] outbound.sendText: OpenIM not connected (account=${accountId ?? "<none>"}, to=${to})`);
        return { ok: false, error: new Error("OpenIM not connected") };
      }
      try {
        await sendTextToTarget(client, target, body);
        // 反向存活探测：成功写回对端（orange）即更新发侧健康时间戳。
        updateLastFlush(client, Date.now());
        (client as any).logger?.info?.(`[openim] outbound.sendText OK: to=${to} textChars=${body.length}`);
        return { ok: true, provider: "openim" };
      } catch (e: any) {
        (client as any).logger?.warn?.(`[openim] outbound.sendText FAILED: to=${to} error=${formatSdkError(e)}`);
        // 反向存活探测：投递失败若是对端管道断裂（EPIPE），立即标记，
        // 并主动退出由 orange 重新拉起本插件，重建 stdin/stdout 通道。
        if (isPipeBrokenError(e)) {
          markStdoutBroken(client, Date.now());
          scheduleStdoutBrokenExit(client);
        }
        return { ok: false, error: new Error(formatSdkError(e)) };
      }
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      channelLogger = ctx?.log;
      const account = getOpenIMAccountConfig(ctx, ctx.accountId);
      if (!account) {
        ctx.log?.error?.(`[openim] no account config found for ${ctx.accountId}`);
        return;
      }
      ctx.setStatus({ accountId: ctx.accountId, running: true });
      ctx.log?.info?.(`[openim] starting openim[${ctx.accountId}]...`);
      await startAccountClient(ctx, account);
      if (connectedClientCount() > 0) {
        ctx.setStatus({ accountId: ctx.accountId, running: true, lastStartAt: Date.now() });
        ctx.log?.info?.(`[openim] openim[${ctx.accountId}] started`);
      } else {
        ctx.setStatus({ accountId: ctx.accountId, running: false, lastError: "Failed to connect" });
        ctx.log?.error?.(`[openim] openim[${ctx.accountId}] start failed`);
      }
    },
    stopAccount: async (ctx: any) => {
      ctx.log?.info?.(`[openim] stopping openim[${ctx.accountId}]...`);
      await stopAllClients(ctx);
      ctx.setStatus({ accountId: ctx.accountId, running: false, lastStopAt: Date.now() });
      ctx.log?.info?.(`[openim] openim[${ctx.accountId}] stopped`);
    },
  },
};
