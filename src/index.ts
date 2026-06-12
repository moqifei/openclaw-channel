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
