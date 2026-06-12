import { getOpenIMUserInfoCache } from "./user";

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function isOpenIMPayload(payload: any): boolean {
  const channel = String(payload?.channel ?? "").trim().toLowerCase();
  if (channel) return channel === "openim";
  const userId = String(payload?.user_id ?? "").trim();
  return userId.startsWith("openim:");
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

    const userID = String(payload?.user_id ?? "").replace(/^openim:/i, "").trim();
    if (!userID) {
      return { action: "continue" };
    }

    const userInfo = getOpenIMUserInfoCache().get(userID);
    api.logger?.info?.(
      `[openim/http-token-injector] hook triggered: tool=${toolName} user=${userID} url=${url} userInfo=${
        userInfo ? `name=${userInfo.name} username=${userInfo.username}` : "not found"
      }`
    );
    if (!userInfo) {
      return { action: "continue" };
    }
    if (Date.now() - userInfo.fetchedAt > userCacheTtlMs) {
      getOpenIMUserInfoCache().delete(userID);
      return { action: "continue" };
    }
    if (!userInfo.username) {
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
          },
        },
      },
    };
  };

  api.registerHook("before_tool_call", hookHandler as any, { name: "openim-http-token-injector", priority: 80 } as any);
}
