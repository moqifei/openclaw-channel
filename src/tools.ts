import { getConnectedClient } from "./clients";
import {
  buildOpenIMDigitalTwinPrompt,
  normalizeOpenIMDigitalTwinReply,
  normalizeOpenIMDigitalTwinTask,
  type OpenIMDigitalTwinReply,
  type OpenIMDigitalTwinTask,
} from "./digital-twin";
import { sendFileToTarget, sendImageToTarget, sendTextToTarget, sendVideoToTarget } from "./media";
import { parseTarget } from "./targets";
import { formatSdkError } from "./utils";

export function registerOpenIMTools(api: any): void {
  if (typeof api.registerTool !== "function") return;

  api.registerTool({
    name: "openim_digital_twin_prepare",
    description:
      "Normalize an OpenIM digital twin HTTP task. This does not open an OpenIM WebSocket account; it returns the session/account scope and prompt for Orange dispatch.",
    parameters: {
      type: "object",
      properties: {
        ownerUserID: { type: "string", description: "Digital twin owner OpenIM user ID" },
        senderUserID: { type: "string", description: "Original sender OpenIM user ID" },
        messageContent: { type: "string", description: "Original text message content" },
        fallbackReplyText: { type: "string", description: "Fallback reply text" },
        prompt: { type: "string", description: "Owner-provided digital twin prompt/persona" },
        serverMsgID: { type: "string", description: "OpenIM server message ID" },
        clientMsgID: { type: "string", description: "OpenIM client message ID" },
        operationID: { type: "string", description: "OpenIM operation ID" },
      },
      required: ["ownerUserID", "senderUserID", "messageContent"],
    },
    async execute(_id: string, params: OpenIMDigitalTwinTask) {
      try {
        const task = normalizeOpenIMDigitalTwinTask(params);
        return {
          ok: true,
          protocol: "openim_digital_twin_http_task",
          task,
          dispatch: {
            channel: task.channel,
            accountId: task.accountId,
            agentId: task.agentId,
            workspaceScope: task.workspaceScope,
            userId: task.senderUserID,
            target: task.target,
            text: buildOpenIMDigitalTwinPrompt(task),
          },
        };
      } catch (e: any) {
        return {
          ok: false,
          error: String(e?.message || e),
        };
      }
    },
  });

  api.registerTool({
    name: "openim_digital_twin_finalize",
    description:
      "Finalize an OpenIM digital twin reply. This does not send the message; it normalizes reply text and metadata for Chat to send and audit.",
    parameters: {
      type: "object",
      properties: {
        ownerUserID: { type: "string", description: "Digital twin owner OpenIM user ID" },
        senderUserID: { type: "string", description: "Original sender OpenIM user ID" },
        replyText: { type: "string", description: "Generated reply text" },
        source: { type: "string", description: "Reply generation source" },
        serverMsgID: { type: "string", description: "OpenIM server message ID" },
        clientMsgID: { type: "string", description: "OpenIM client message ID" },
        operationID: { type: "string", description: "OpenIM operation ID" },
      },
      required: ["ownerUserID", "senderUserID", "replyText"],
    },
    async execute(_id: string, params: OpenIMDigitalTwinReply) {
      try {
        const reply = normalizeOpenIMDigitalTwinReply(params);
        return {
          ok: true,
          protocol: "openim_digital_twin_http_task",
          reply,
        };
      } catch (e: any) {
        return {
          ok: false,
          error: String(e?.message || e),
        };
      }
    },
  });

  const ensureTargetAndClient = (params: { target?: string; accountId?: string }) => {
    const target = parseTarget(params.target);
    if (!target) {
      return {
        ok: false as const,
        result: {
          content: [{ type: "text", text: "Invalid target format. Expected user:<id> or group:<id>." }],
        },
      };
    }
    // Digital twin accounts (digital_twin:<ownerID>) are scope identifiers for
    // orange's workspace routing, not real OpenIM SDK connections.  Sending via
    // them would fall back to the robot's SDK client and produce a message with
    // the wrong sender identity.  In digital-twin mode the LLM must use
    // openim_digital_twin_finalize so that chat can send on behalf of the owner.
    if ((params.accountId ?? "").startsWith("digital_twin:")) {
      const guidance =
        "In digital-twin mode you must NOT send messages directly. " +
        "Use openim_digital_twin_finalize to return your reply text so that " +
        "the chat service can deliver it with the correct sender identity.";
      return {
        ok: false as const,
        result: {
          // `content` carries the guidance back to the LLM so it can self-correct
          // and call openim_digital_twin_finalize instead.
          content: [{ type: "text", text: guidance }],
          // `error` makes orange treat this as a tool failure, so the
          // ToolFailureBreaker suppresses repeated openim_send_* calls and the
          // agent loop stops wasting turns retrying the blocked send.
          error: guidance,
        },
      };
    }
    const client = getConnectedClient(params.accountId);
    if (!client) {
      return {
        ok: false as const,
        result: {
          content: [{ type: "text", text: "OpenIM is not connected." }],
        },
      };
    }
    return { ok: true as const, target, client };
  };

  api.registerTool({
    name: "openim_send_text",
    description: "Send a text message via OpenIM. target format: user:ID or group:ID.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        text: { type: "string", description: "Text to send" },
        accountId: { type: "string", description: "Optional account ID. Defaults to `default` or the first connected account." },
      },
      required: ["target", "text"],
    },
    async execute(_id: string, params: { target: string; text: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendTextToTarget(checked.client, checked.target, params.text);
        return { content: [{ type: "text", text: "Sent successfully" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });

  api.registerTool({
    name: "openim_send_image",
    description: "Send an image via OpenIM. `image` supports a local path or an http(s) URL.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        image: { type: "string", description: "Local path (`file://` supported) or URL" },
        accountId: { type: "string", description: "Optional account ID" },
      },
      required: ["target", "image"],
    },
    async execute(_id: string, params: { target: string; image: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendImageToTarget(checked.client, checked.target, params.image);
        return { content: [{ type: "text", text: "Image sent successfully" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });

  api.registerTool({
    name: "openim_send_video",
    description: "Send a video via OpenIM (delivered as a file message). `video` supports a local path or URL.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        video: { type: "string", description: "Local path (`file://` supported) or URL" },
        name: { type: "string", description: "Optional filename (recommended for URL input)" },
        accountId: { type: "string", description: "Optional account ID" },
      },
      required: ["target", "video"],
    },
    async execute(_id: string, params: { target: string; video: string; name?: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendVideoToTarget(checked.client, checked.target, params.video, params.name);
        return { content: [{ type: "text", text: "Video sent successfully as a file" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });

  api.registerTool({
    name: "openim_send_file",
    description: "Send a file via OpenIM. `file` supports a local path or URL; `name` is optional.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "user:123 or group:456" },
        file: { type: "string", description: "Local path (`file://` supported) or URL" },
        name: { type: "string", description: "Optional filename (recommended for URL input)" },
        accountId: { type: "string", description: "Optional account ID" },
      },
      required: ["target", "file"],
    },
    async execute(_id: string, params: { target: string; file: string; name?: string; accountId?: string }) {
      const checked = ensureTargetAndClient(params);
      if (!checked.ok) return checked.result;
      try {
        await sendFileToTarget(checked.client, checked.target, params.file, params.name);
        return { content: [{ type: "text", text: "File sent successfully" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Send failed: ${formatSdkError(e)}` }] };
      }
    },
  });
}
