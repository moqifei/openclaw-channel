/**
 * OpenClaw OpenIM Channel Plugin
 *
 * Integrates OpenIM into OpenClaw Gateway using @openim/client-sdk.
 * Supports multi-account concurrency, direct/group text messaging, and mention-gated group triggering.
 */

import "./polyfills";
import { OpenIMChannelPlugin } from "./channel";
import { connectedClientCount, startAccountClient, stopAllClients } from "./clients";
import { listEnabledAccountConfigs } from "./config";
import { registerHttpTokenInjector } from "./http-token-injector";
import { registerOpenIMTools } from "./tools";

// 全局兜底：任何未捕获异常 / 未处理的 Promise 拒绝都只记录日志，绝不退出进程。
// 否则 open-im-server 重启、网络抖动、SDK 回调抛错等偶发异常会直接 kill 整个
// channel 子进程，触发 orange supervisor 反复 respawn，导致所有分身用户被波及、
// 机器人频繁重连/掉线。测试环境（server 重启、SDK 半死）比本地更容易触发此问题。
const channelLogger = (() => {
  try {
    return (globalThis as any).__openimApi?.logger;
  } catch {
    return undefined;
  }
})();
function safeLog(level: "error" | "warn", msg: string): void {
  try {
    channelLogger?.[level]?.(msg);
  } catch {
    // 日志本身不可用时退回到 stderr，避免静默丢失关键信息。
    process.stderr.write(`[openim][${level}] ${msg}\n`);
  }
}
process.on("uncaughtException", (err: unknown) => {
  safeLog("error", `[openim] uncaughtException (ignored, process kept alive): ${String(err)} ${err instanceof Error ? err.stack ?? "" : ""}`);
});
process.on("unhandledRejection", (reason: unknown) => {
  safeLog("error", `[openim] unhandledRejection (ignored, process kept alive): ${String(reason)}`);
});

export {
  OpenIMDigitalTwinProtocol,
  buildOpenIMDigitalTwinPrompt,
  digitalTwinAccountId,
  digitalTwinAgentId,
  normalizeOpenIMDigitalTwinReply,
  normalizeOpenIMDigitalTwinTask,
} from "./digital-twin";
export type {
  NormalizedOpenIMDigitalTwinReply,
  NormalizedOpenIMDigitalTwinTask,
  OpenIMDigitalTwinReply,
  OpenIMDigitalTwinTask,
} from "./digital-twin";

export default function register(api: any): void {
  (globalThis as any).__openimApi = api;
  (globalThis as any).__openimGatewayConfig = api.config;

  api.registerChannel({ plugin: OpenIMChannelPlugin });

  if (typeof api.registerCli === "function") {
    api.registerCli(
      (ctx: any) => {
        const prog = ctx.program;
        if (prog && typeof prog.command === "function") {
          const openim = prog.command("openim").description("OpenIM channel configuration");
          openim.command("setup").description("Interactive setup for the OpenIM default account").action(async () => {
            const { runOpenIMSetup } = await import("./setup");
            await runOpenIMSetup();
          });
        }
      },
      { commands: ["openim"] }
    );
  }

  registerOpenIMTools(api);
  registerHttpTokenInjector(api);

  api.registerService({
    id: "openim-sdk",
    start: async () => {
      if (connectedClientCount() > 0) {
        api.logger?.info?.("[openim] service already started");
        return;
      }

      const accounts = listEnabledAccountConfigs(api);
      if (accounts.length === 0) {
        api.logger?.warn?.("[openim] no enabled account config found");
        return;
      }

      for (const account of accounts) {
        await startAccountClient(api, account);
      }

      api.logger?.info?.(`[openim] service started with ${connectedClientCount()}/${accounts.length} connected accounts`);
    },
    stop: async () => {
      await stopAllClients(api);
      api.logger?.info?.("[openim] service stopped");
    },
  });

  api.logger?.info?.("[openim] plugin loaded");
}
