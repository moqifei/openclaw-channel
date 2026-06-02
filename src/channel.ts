import { connectedClientCount, getConnectedClient, startAccountClient, stopAllClients } from "./clients";
import { getOpenIMAccountConfig, listAccountIds, resolveAccountConfig } from "./config";
import { sendTextToTarget } from "./media";
import { parseTarget } from "./targets";
import { formatSdkError } from "./utils";

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
    sendText: async ({ to, text, accountId }: { to: string; text: string; accountId?: string }) => {
      const target = parseTarget(to);
      if (!target) {
        return { ok: false, error: new Error("invalid target, expected user:<id> or group:<id>") };
      }
      const client = getConnectedClient(accountId);
      if (!client) {
        return { ok: false, error: new Error("OpenIM not connected") };
      }
      try {
        await sendTextToTarget(client, target, text);
        return { ok: true, provider: "openim" };
      } catch (e: any) {
        return { ok: false, error: new Error(formatSdkError(e)) };
      }
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
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
