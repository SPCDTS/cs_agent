import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { showLogin } from "./app";
import { Diagnostic, type RefreshDiagnostic } from "./app-contracts";
export { Diagnostic, type RefreshDiagnostic };

export const TOKEN_KEY = "joule-admin-token";
const ErrorBody = Type.Object({
  error: Type.Optional(Type.String()), reason: Type.Optional(Type.String()), current: Type.Optional(Type.Unknown()),
  diagnostic: Type.Optional(Diagnostic),
  rejectedTools: Type.Optional(Type.Array(Type.Object({ name: Type.String(), reason: Type.String() }))),
});
export class ApiError extends Error {
  readonly body: Static<typeof ErrorBody> | null;
  constructor(readonly status: number, value: unknown) {
    super("api " + status);
    this.body = Check(ErrorBody, value) ? value : null;
  }
}
export const readToken = () => {
  try {
    const current = sessionStorage.getItem(TOKEN_KEY);
    if (current) return current;
    const legacy = sessionStorage.getItem("cs-agent-admin-token");
    if (legacy) {
      sessionStorage.setItem(TOKEN_KEY, legacy);
      sessionStorage.removeItem("cs-agent-admin-token");
      return legacy;
    }
    return null;
  } catch { return null; }
};
export const writeToken = (value: string | null) => { try { if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY); } catch {} };

/** 返回值在调用方按所需视图 schema 校验，写操作可以直接忽略正文。 */
export async function api(method: string, path: string, body?: unknown, isCurrent: () => boolean = () => true): Promise<unknown> {
  if (!isCurrent()) throw new Error("stale_admin_request");
  const token = readToken();
  if (!token) { showLogin(""); throw new ApiError(401, null); }
  const headers: Record<string, string> = { Authorization: "Bearer " + token };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!isCurrent()) throw new Error("stale_admin_request");
  if (response.status === 401) { writeToken(null); showLogin("口令无效或已失效，请重新输入"); throw new ApiError(401, null); }
  const raw = await response.text();
  if (!isCurrent()) throw new Error("stale_admin_request");
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { error: raw.slice(0, 60) }; }
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}
export async function readApi<T extends TSchema>(schema: T, method: string, path: string, body?: unknown, isCurrent: () => boolean = () => true): Promise<Static<T>> {
  const value = await api(method, path, body, isCurrent);
  if (!isCurrent()) throw new Error("stale_admin_request");
  if (!Check(schema, value)) throw new Error("invalid_admin_response: " + path.split("?")[0]);
  return value;
}
