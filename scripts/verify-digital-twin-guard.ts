/**
 * Local verification for the digital-twin send guard.
 *
 * This does NOT need a real OpenIM connection. The digital-twin branch in
 * `ensureTargetAndClient` returns before `getConnectedClient` is ever called,
 * so we can drive the real tool `execute` with a mocked gateway api and assert
 * that the rejection carries an `error` field (which orange's dispatcher uses to
 * flag the tool call as failed and arm the ToolFailureBreaker).
 *
 * The send tools are registered as FACTORIES `(toolCtx) => toolDef`.  The real
 * openclaw shim re-invokes the factory at execution time with the per-dispatch
 * `ctx` (`entry.factory(effectiveCtx)`), which is how the tool learns it is in
 * digital-twin mode.  This mock mirrors that behaviour so the test exercises the
 * exact path that runs in production.
 *
 * Run:  npx tsx scripts/verify-digital-twin-guard.ts
 */
import { registerOpenIMTools } from "../src/tools.ts";

type AnyTool = {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
};
type ToolFactory = (toolCtx: any) => AnyTool;

function collectTools(): { factories: Map<string, ToolFactory> } {
  const factories = new Map<string, ToolFactory>();
  const api = {
    registerTool(toolOrFactory: AnyTool | ToolFactory) {
      // Mirror the shim: normalise object → factory, then read the name once
      // with an empty ctx (the shim uses a fakeCtx for schema extraction).
      const factory: ToolFactory =
        typeof toolOrFactory === "function"
          ? (toolOrFactory as ToolFactory)
          : () => toolOrFactory as AnyTool;
      const def = factory({});
      factories.set(def.name, factory);
    },
  };
  registerOpenIMTools(api);
  return { factories };
}

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

async function main() {
  const { factories } = collectTools();
  // exec(name, params, toolCtx) re-invokes the factory with the dispatch ctx,
  // exactly like the shim does at execution time.
  const exec = (name: string, params: any, toolCtx: any = {}) =>
    factories.get(name)!(toolCtx).execute("call", params);

  console.log("[1] digital_twin accountId on openim_send_text must be rejected with `error`");
  const r1 = await exec("openim_send_text", {
    target: "user:123",
    text: "hello",
    accountId: "digital_twin:owner1",
  });
  check("result has `error` field", typeof r1.error === "string" && r1.error.length > 0, r1);
  check("result still has `content` guidance", Array.isArray(r1.content) && r1.content.length > 0, r1);
  check(
    "error mentions openim_digital_twin_finalize",
    typeof r1.error === "string" && r1.error.includes("openim_digital_twin_finalize"),
    r1,
  );

  console.log("[2] same guard applies to openim_send_image");
  const r2 = await exec("openim_send_image", {
    target: "user:123",
    image: "/tmp/x.png",
    accountId: "digital_twin:owner1",
  });
  check("image send also carries `error`", typeof r2.error === "string" && r2.error.length > 0, r2);

  console.log("[3] a non-digital_twin accountId is NOT rejected by the guard (reaches client lookup)");
  const r3 = await exec("openim_send_text", {
    target: "user:123",
    text: "hello",
    accountId: "default",
  });
  // No connected client in this script, so it returns the "not connected" result
  // WITHOUT an `error` field — that is the pre-existing behaviour we are NOT changing.
  check("non-digital-twin path has no digital-twin `error`", r3.error === undefined, r3);

  console.log("[4] params.ctx.digital_twin (no explicit accountId) must also be rejected");
  const r4 = await exec("openim_send_text", {
    target: "user:123",
    text: "hello",
    ctx: { digital_twin: { accountId: "digital_twin:owner1", agentId: "openim1" } },
  });
  check("params.ctx.digital_twin path has `error` field", typeof r4.error === "string" && r4.error.length > 0, r4);

  console.log("[5] FACTORY-injected toolCtx.digital_twin (the real prod path) must be rejected");
  // This is the actual bridge behaviour: the LLM calls openim_send_text with only
  // {target, text}; the dispatch ctx carrying digital_twin is injected by the
  // shim into the factory, NOT into execute params.
  const r5 = await exec(
    "openim_send_text",
    { target: "user:123", text: "hello" },
    { digital_twin: { accountId: "digital_twin:owner1", agentId: "openim1" } },
  );
  check("toolCtx.digital_twin path has `error` field", typeof r5.error === "string" && r5.error.length > 0, r5);
  check(
    "toolCtx.digital_twin error mentions openim_digital_twin_finalize",
    typeof r5.error === "string" && r5.error.includes("openim_digital_twin_finalize"),
    r5,
  );

  console.log("[6] boolean toolCtx.digital_twin === true must also be rejected");
  // prepare/finalize dispatches carry ctx.digital_twin as the boolean `true`.
  const r6 = await exec(
    "openim_send_text",
    { target: "user:123", text: "hello" },
    { digital_twin: true },
  );
  check("boolean toolCtx.digital_twin path has `error` field", typeof r6.error === "string" && r6.error.length > 0, r6);

  console.log("");
  if (failures > 0) {
    console.error(`VERIFY FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("VERIFY OK: digital-twin send guard emits `error` as expected.");
}

main().catch((e) => {
  console.error("verify script crashed:", e);
  process.exit(1);
});
