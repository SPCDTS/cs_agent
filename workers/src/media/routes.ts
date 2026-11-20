import { FILE_MAX_BYTES, type AssetKind } from "./model";
import { MediaRepository, readMediaToken } from "./repository";
import { readBoundedBytes } from "../shared/http-body";

export type MediaRouteDeps = { bucket: R2Bucket; authenticateAdmin(request: Request): boolean | Promise<boolean> };
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" };
/** 返回 undefined 时由主路由继续匹配；对象票据之外的读写均要求管理员认证。 */
export async function handleMediaRequest(request: Request, deps: MediaRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/media/")) return undefined;
  try {
    if (request.method === "GET" && url.pathname === "/media/object") {
      const { ref, bytes } = await readMediaToken(deps.bucket, url.searchParams.get("token") ?? "");
      return new Response(bytes, { headers: { ...headers, "Content-Type": ref.mime, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(ref.name)}` } });
    }
    if (!await deps.authenticateAdmin(request)) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const match = /^\/media\/assets\/([^/]+)(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
    if (!match?.[1]) return Response.json({ error: "not_found" }, { status: 404, headers });
    const repository = new MediaRepository({ bucket: deps.bucket, scope: decodeURIComponent(match[1]) });
    if (request.method === "GET" && match[2]) {
      const { ref, bytes } = await repository.get(match[2]);
      return new Response(bytes, { headers: { ...headers, "Content-Type": ref.mime, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(ref.name)}` } });
    }
    if (request.method === "POST" && !match[2]) {
      const bytes = await readBoundedBytes(request, { maxBytes: FILE_MAX_BYTES });
      const kind = url.searchParams.get("kind") ?? "file";
      const isKind = (value: string): value is AssetKind => ["image", "file", "audio", "video"].includes(value);
      if (!isKind(kind)) throw new Error("invalid_media_kind");
      const ref = await repository.put({ bytes, name: url.searchParams.get("name") ?? "attachment", mime: request.headers.get("Content-Type") ?? undefined, kind });
      return Response.json(ref, { status: 201, headers });
    }
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "media_error";
    return Response.json({ error: code }, { status: code === "too_large" ? 413 : /token|scope/.test(code) ? 403 : code === "asset_not_found" ? 404 : 400, headers });
  }
}
