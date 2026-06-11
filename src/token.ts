import type { OpenIMAccountConfig } from "./types";

interface OpenIMTokenResponse {
  errCode?: number;
  errMsg?: string;
  errDlt?: string;
  data?: {
    token?: string;
    expireTimeSeconds?: number;
  };
  token?: string;
}

function tokenFromResponse(body: OpenIMTokenResponse): string {
  const token = String(body?.data?.token ?? body?.token ?? "").trim();
  if (token) return token;

  const errCode = body?.errCode;
  const message = [body?.errMsg, body?.errDlt].map((item) => String(item ?? "").trim()).filter(Boolean).join(": ");
  throw new Error(`OpenIM token response did not include token${errCode === undefined ? "" : ` (errCode=${errCode})`}${message ? `: ${message}` : ""}`);
}

async function postJson<T>(apiAddr: string, path: string, headers: Record<string, string>, body: unknown): Promise<T> {
  const url = new URL(path, apiAddr.endsWith("/") ? apiAddr : `${apiAddr}/`).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      operationID: String(Date.now()),
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { token: text.trim() };
    }
  }

  if (!res.ok) {
    throw new Error(`OpenIM token request ${path} failed with HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  return parsed as T;
}

export async function resolveAccountToken(config: OpenIMAccountConfig): Promise<string> {
  const existing = String(config.token ?? "").trim();
  if (existing) return existing;

  const adminBody = await postJson<OpenIMTokenResponse>(
    config.apiAddr,
    "/auth/get_admin_token",
    {},
    {
      secret: config.adminSecret,
      userID: config.adminUserID,
    }
  );
  const adminToken = tokenFromResponse(adminBody);

  const userBody = await postJson<OpenIMTokenResponse>(
    config.apiAddr,
    "/auth/get_user_token",
    { token: adminToken },
    {
      userID: config.userID,
      platformID: config.platformID,
    }
  );

  return tokenFromResponse(userBody);
}
