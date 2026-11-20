import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import { BodyLimitError, readBoundedJson } from "../shared/http-body";

export const API_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: object = {}) {
    super(code);
  }
}

export const adminJson = (body: unknown, status = 200) => Response.json(body, { status, headers: API_HEADERS });

export const adminPlain = (body: string, status: number) =>
  new Response(body, { status, headers: { ...API_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });

export interface AdminBodyOptions {
  maxBytes?: number;
  fatal?: boolean;
  tooLargeCode?: string;
}

export async function readAdminJson(request: Request, options: AdminBodyOptions = {}): Promise<unknown> {
  try {
    if (options.maxBytes !== undefined) {
      return await readBoundedJson(request, { maxBytes: options.maxBytes, requireBody: true, fatal: options.fatal });
    }
    return await request.json();
  } catch (error) {
    if (error instanceof BodyLimitError && error.kind === "too_large") {
      throw new HttpError(413, options.tooLargeCode ?? "request_too_large");
    }
    throw new HttpError(400, "invalid_json");
  }
}

export async function readAdminBody<T extends TSchema>(
  request: Request,
  schema: T,
  options: AdminBodyOptions = {},
): Promise<Static<T>> {
  const value = await readAdminJson(request, options);
  if (!Check(schema, value)) throw new HttpError(400, "invalid_request");
  return value;
}
