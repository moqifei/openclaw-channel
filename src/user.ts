import type { OpenIMClientState } from "./types";
import { toPinyinName } from "./pinyin";

export interface OpenIMUserInfo {
  userID: string;
  name: string;
  username: string;
  email: string;
  mobile: string;
  employeeNo: string;
  faceURL: string;
  fetchedAt: number;
}

const USER_INFO_CACHE_KEY = "__orange_openim_user_info_cache__";

const userInfoGlobal = globalThis as typeof globalThis & {
  [USER_INFO_CACHE_KEY]?: Map<string, OpenIMUserInfo>;
};

if (!userInfoGlobal[USER_INFO_CACHE_KEY]) {
  userInfoGlobal[USER_INFO_CACHE_KEY] = new Map();
}

export function getOpenIMUserInfoCache(): Map<string, OpenIMUserInfo> {
  return userInfoGlobal[USER_INFO_CACHE_KEY]!;
}

function readJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase().replace(/@.*$/, "").replace(/[^a-z0-9._-]/g, "");
}

async function fetchChatUserInfo(client: OpenIMClientState, userID: string): Promise<Record<string, unknown> | null> {
  const apiAddr = client.config.chatApiAddr;
  const token = client.config.chatToken;
  if (!apiAddr || !token) return null;

  const url = new URL("/user/find/full", apiAddr.endsWith("/") ? apiAddr : `${apiAddr}/`).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      token,
    },
    body: JSON.stringify({ userIDs: [userID] }),
  });
  if (!res.ok) {
    throw new Error(`chat user lookup failed with HTTP ${res.status}`);
  }

  const body = (await res.json()) as any;
  const users = body?.data?.users ?? body?.users ?? body?.data?.Users ?? [];
  if (!Array.isArray(users) || users.length === 0) return null;
  return users.find((item: any) => String(item?.userID ?? item?.userId ?? "") === userID) ?? users[0];
}

export function buildOpenIMUserInfo(raw: any, fallbackUserID: string, fallbackName = ""): OpenIMUserInfo {
  const ex = readJsonObject(raw?.ex);
  const userID = firstString(raw?.userID, fallbackUserID);
  const name = firstString(raw?.nickname, raw?.name, raw?.displayName, ex.name, ex.displayName, fallbackName, userID);
  const email = firstString(raw?.email, raw?.enterpriseEmail, raw?.enterprise_email, ex.email, ex.enterpriseEmail, ex.enterprise_email);
  const username =
    normalizeUsername(firstString(raw?.account, raw?.username, raw?.userName, ex.username, ex.userName, ex.account, ex.loginName, ex.pinyin, ex.pinYin, email)) ||
    normalizeUsername(toPinyinName(name)) ||
    normalizeUsername(userID);

  return {
    userID,
    name,
    username,
    email,
    mobile: firstString(raw?.mobile, raw?.phone, ex.mobile, ex.phone),
    employeeNo: firstString(raw?.employeeNo, raw?.employee_no, ex.employeeNo, ex.employee_no),
    faceURL: firstString(raw?.faceURL, raw?.faceUrl, ex.faceURL, ex.faceUrl),
    fetchedAt: Date.now(),
  };
}

export async function resolveOpenIMUserInfo(params: {
  client: OpenIMClientState;
  userID: string;
  fallbackName?: string;
  log?: (...args: unknown[]) => void;
}): Promise<OpenIMUserInfo> {
  const { client, userID, fallbackName = "", log } = params;
  const cache = getOpenIMUserInfoCache();
  const cached = cache.get(userID);
  if (cached) return cached;

  try {
    const chatUser = await fetchChatUserInfo(client, userID);
    if (chatUser) {
      const info = buildOpenIMUserInfo(chatUser, userID, fallbackName);
      cache.set(userID, info);
      return info;
    }
  } catch (err) {
    log?.(`[openim] chat user lookup failed for ${userID}: ${String(err)}`);
  }

  try {
    const res: any = await client.sdk.getUsersInfo([userID]);
    const users = Array.isArray(res?.data) ? res.data : [];
    const raw = users.find((item: any) => String(item?.userID ?? "") === userID) ?? users[0];
    const info = buildOpenIMUserInfo(raw, userID, fallbackName);
    cache.set(userID, info);
    return info;
  } catch (err) {
    log?.(`[openim] getUsersInfo failed for ${userID}: ${String(err)}`);
    const info = buildOpenIMUserInfo(null, userID, fallbackName);
    cache.set(userID, info);
    return info;
  }
}
