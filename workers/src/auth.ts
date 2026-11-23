import { timingSafeEqual } from "node:crypto";
import { sha256Bytes } from "./shared/hash";

export async function authenticated(request: Request, secret: string | undefined, queryToken = false): Promise<boolean> {
  if (!secret) return false;
  const header = request.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : queryToken ? new URL(request.url).searchParams.get("access_token") : null;
  if (token === null) return false;
  // 固定长度摘要交给原生常量时间比较，避免逐字符比较泄露匹配前缀。
  return secretsEqual(token, secret);
}

export function secretsEqual(provided: string, expected: string) {
  return timingSafeEqual(sha256Bytes(provided), sha256Bytes(expected));
}
