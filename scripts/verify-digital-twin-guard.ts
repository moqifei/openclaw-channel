/**
 * Local verification for the digital-twin send guard.
 *
 * This does NOT need a real OpenIM connection. The digital-twin branch in
 * `ensureTargetAndClient` returns before `getConnectedClient` is ever called,
 * so we can drive the real tool `execute` with a mocked gateway api and assert
 * that the rejection now carries an `error` field (which orange's dispatcher
 * uses to flag the tool call as failed and arm the ToolFailureBreaker).
 *
 * Run:  npx tsx scripts/verify-digital-twin-guard.ts
 */
import { registerOpenIMTools } from "../src/tools.ts";

type AnyTool = {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
};

function collectTools(): { api: any; tools: Map<string, AnyTool> } {
  const tools = new Map<string, AnyTool>();
  const api = {
    registerTool(tool: AnyTool) {
      tools.set(tool.name, tool);
    },
  };
  registerOpenIMTools(api);
  return { api, tools };
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
  const { tools } = collectTools();
  const sendText = tools.get("openim_send_text")!;
  const sendImage = tools.get("openim_send_image")!;

  console.log("[1] digital_twin accountId on openim_send_text must be rejected with `error`");
  const r1 = await sendText.execute("call-1", {
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
  const r2 = await sendImage.execute("call-2", {
    target: "user:123",
    image: "/tmp/x.png",
    accountId: "digital_twin:owner1",
  });
  check("image send also carries `error`", typeof r2.error === "string" && r2.error.length > 0, r2);

  console.log("[3] a non-digital_twin accountId is NOT rejected by the guard (reaches client lookup)");
  const r3 = await sendText.execute("call-3", {
    target: "user:123",
    text: "hello",
    accountId: "default",
  });
  // No connected client in this script, so it returns the "not connected" result
  // WITHOUT an `error` field — that is the pre-existing behaviour we are NOT changing.
  check("non-digital-twin path has no digital-twin `error`", r3.error === undefined, r3);

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
