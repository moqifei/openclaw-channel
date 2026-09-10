import { getConnectedClient } from "./clients";
import { OpenIMDigitalTwinProtocol } from "./digital-twin";
import { getOpenIMUserInfoCache, resolveOpenIMUserInfo, type OpenIMUserInfo } from "./user";

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function isOpenIMPayload(payload: any): boolean {
  const channel = String(payload?.channel ?? "").trim().toLowerCase();
  if (channel) return channel === "openim";
  const userId = String(payload?.user_id ?? "").trim();
  return userId.startsWith("openim:");
}

function stripOpenIMPrefix(value: unknown): string {
  return String(value ?? "").replace(/^openim:/i, "").trim();
}

interface CallerIdentity {
  /** 网关调用实际使用的身份（token / username 都基于它解析）。 */
  userID: string;
  /** 原始入站发送者，仅用于审计头。 */
  senderUserID: string;
  /** 非空表示本次调用发生在数字分身上下文中，值为分身主人 ID。 */
  ownerUserID: string;
}

/**
 * 决定本次网关调用应以「谁」的身份发起。
 *
 * - 普通 IM 机器人模式：使用入站发送者（sender）。
 * - 数字分身模式：必须使用分身「主人」（owner），而不是消息发送者。
 *   原因有二：
 *   1) 语义上分身是代表主人回话的（"查一下你的 OA 待办" 指的是主人的待办，
 *      用发送者身份会查到别人的数据）；
 *   2) 工程上发送者 ID 从未被解析进用户信息缓存（inbound.ts 只解析普通入站
 *      发送者，分身链路不走那里），用它查缓存必然 not found，导致 token 与
 *      用户名注入被跳过，网关收不到真实账号（拼音姓名）而拒绝请求。
 *      分身主人的信息会在 openim_digital_twin_prepare 阶段被解析并缓存，
 *      因此以 owner 身份查找是可靠且语义正确的。
 */
function resolveCallerIdentity(payload: any): CallerIdentity {
  const senderUserID = stripOpenIMPrefix(payload?.user_id);
  const accountId = String(payload?.account_id ?? "").trim();
  const prefix = OpenIMDigitalTwinProtocol.accountScopePrefix;
  if (prefix && accountId.toLowerCase().startsWith(prefix.toLowerCase())) {
    const ownerUserID = stripOpenIMPrefix(accountId.slice(prefix.length));
    if (ownerUserID) {
      return { userID: ownerUserID, senderUserID, ownerUserID };
    }
  }
  return { userID: senderUserID, senderUserID, ownerUserID: "" };
}

export function registerHttpTokenInjector(api: any): void {
  const cfg = ((api.pluginConfig as any)?.http_token_injector ?? {}) as Record<string, unknown>;

  const tokenServiceUrl = String(cfg.token_service_url ?? "").trim();
  const publicKey = String(cfg.public_key ?? "").trim();
  const tokenTtlMs = Number(cfg.token_ttl_ms ?? 5 * 60 * 1000);
  const userCacheTtlMs = Number(cfg.user_cache_ttl_ms ?? 30 * 60 * 1000);
  const targetUrlPrefix = String(cfg.target_url_prefix ?? "http://").trim();

  if (!tokenServiceUrl) {
    api.logger?.warn?.("[openim/http-token-injector] token_service_url not configured; disabled");
    return;
  }
  if (!publicKey) {
    api.logger?.warn?.("[openim/http-token-injector] public_key not configured; disabled");
    return;
  }

  /**
   * 取用户信息：命中缓存直接返回，缺失或过期则按需重新解析。
   * 数字分身自测、缓存被清理、首次调用等场景都能兜住，而不是直接放弃注入。
   */
  const loadUserInfo = async (
    payload: any,
    identity: CallerIdentity
  ): Promise<OpenIMUserInfo | undefined> => {
    const userID = identity.userID;
    const cached = getOpenIMUserInfoCache().get(userID);
    if (cached && cached.username && Date.now() - cached.fetchedAt <= userCacheTtlMs) {
      return cached;
    }
    if (cached) getOpenIMUserInfoCache().delete(userID);

    try {
      // 分身没有自己的 WS 账号（perTwinAccount=false），传 undefined 让
      // getConnectedClient 回落到 default/第一个在线账号来做用户查询。
      const client = getConnectedClient(identity.ownerUserID ? undefined : String(payload?.account_id ?? "").trim() || undefined);
      if (!client) return undefined;
      return await resolveOpenIMUserInfo({
        client,
        userID,
        log: (line) => api.logger?.warn?.(String(line)),
      });
    } catch (err) {
      api.logger?.warn?.(`[openim/http-token-injector] resolve user info failed for ${userID}: ${String(err)}`);
      return undefined;
    }
  };

  const hookHandler = async (payload: any): Promise<any> => {
    if (!isOpenIMPayload(payload)) {
      return { action: "continue" };
    }

    const toolName = String(payload?.tool_name ?? "");
    if (toolName !== "http_get" && toolName !== "http_post") {
      return { action: "continue" };
    }

    const url = String(payload?.params?.url ?? "");
    if (targetUrlPrefix && !url.startsWith(targetUrlPrefix)) {
      return { action: "continue" };
    }

    const identity = resolveCallerIdentity(payload);
    const userID = identity.userID;
    if (!userID) {
      return { action: "continue" };
    }

    const userInfo = await loadUserInfo(payload, identity);
    api.logger?.info?.(
      `[openim/http-token-injector] hook triggered: tool=${toolName} user=${userID}` +
        (identity.ownerUserID
          ? ` (digital-twin owner=${identity.ownerUserID} sender=${identity.senderUserID || "-"})`
          : "") +
        ` url=${url} userInfo=${
          userInfo ? `name=${userInfo.name} username=${userInfo.username}` : "not found"
        }`
    );
    if (!userInfo || !userInfo.username) {
      return { action: "continue" };
    }

    let token: string;
    const cachedToken = tokenCache.get(userID);
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
      token = cachedToken.token;
    } else {
      try {
        const res = await fetch(tokenServiceUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: userInfo.username, publicKey }),
        });
        if (!res.ok) {
          api.logger?.warn?.(`[openim/http-token-injector] validateUser returned ${res.status} for ${userID}`);
          return { action: "continue" };
        }
        const data = (await res.json()) as Record<string, unknown>;
        if (!data.valid) {
          api.logger?.warn?.(`[openim/http-token-injector] validateUser failed for ${userID}: ${String(data.message ?? "")}`);
          return { action: "continue" };
        }
        token = String(data.token ?? "").trim();
        if (!token) {
          api.logger?.warn?.(`[openim/http-token-injector] validateUser returned no token for ${userID}`);
          return { action: "continue" };
        }
        tokenCache.set(userID, { token, expiresAt: Date.now() + tokenTtlMs });
      } catch (err) {
        api.logger?.warn?.(`[openim/http-token-injector] validateUser request failed: ${String(err)}`);
        return { action: "continue" };
      }
    }

    const existingHeaders = (payload.params?.headers ?? {}) as Record<string, string>;
    if (existingHeaders.Authorization || existingHeaders.authorization) {
      return { action: "continue" };
    }

    const auditHeaders: Record<string, string> = {};
    if (identity.ownerUserID) {
      auditHeaders["X-Digital-Twin-Owner"] = identity.ownerUserID;
    }
    if (identity.senderUserID && identity.senderUserID !== userID) {
      auditHeaders["X-Sender-Id"] = identity.senderUserID;
    }

    return {
      action: "modify",
      payload: {
        ...payload,
        params: {
          ...payload.params,
          headers: {
            ...existingHeaders,
            Authorization: `Bearer ${token}`,
            username: userInfo.username,
            token,
            "X-User-Id": userID,
            "X-User-Name": userInfo.name,
            ...auditHeaders,
          },
        },
      },
    };
  };

  api.registerHook("before_tool_call", hookHandler as any, { name: "openim-http-token-injector", priority: 80 } as any);
}
