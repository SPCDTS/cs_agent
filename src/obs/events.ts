import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventService } from "../agent/events/service.js";
import { EventManagementError } from "../agent/events/types.js";
import { equal, guardDashboardOrigin, HttpError, validateDashboardPost } from "./dashboard-io.js";
import { eventsBody } from "./ui/events-pages.js";
import { page } from "./ui/html.js";

export type EventManagement = Pick<EventService, "list" | "recentRuns" | "pause" | "resume" | "pollNow">;
export const isEventsPath = (path: string) => path === "/api/events" || path.startsWith("/api/events/") || path === "/events" || path.startsWith("/events/");
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));

/** 面板 cookie 已由组合入口验证；本模块统一校验事件 JSON 与表单操作。 */
export function createEventRoutes(service: EventManagement | undefined, csrf: string) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, host: string, nonce: string): Promise<void> => {
    const api = url.pathname.startsWith("/api/");
    try {
      if (req.method === "GET") {
        if (url.pathname !== "/events" && url.pathname !== "/api/events") throw new HttpError(404, "接口不存在");
        const view = { sources: await service?.list() ?? [], runs: await service?.recentRuns(50) ?? [] };
        if (api) { json(res, 200, { ...view, csrf }); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page({ title: "事件", path: "/events", nonce,
          lead: "外部事件在 owner 私聊开启只读分诊回合；暂停后保留积压，恢复后继续处理。", body: eventsBody(view, csrf) })); return;
      }
      if (req.method !== "POST") throw new HttpError(405, "只支持 GET / POST");
      if (api) {
        guardDashboardOrigin(req, host);
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "只接受 application/json");
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
          if (size > 4096) { req.resume(); throw new HttpError(413, "提交内容过大"); } chunks.push(bytes);
        }
        let body: unknown;
        try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new HttpError(400, "请求体必须是 JSON 对象"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "请求体必须是 JSON 对象");
        const supplied = req.headers["x-csrf-token"] ?? ("_csrf" in body ? body._csrf : undefined);
        if (!csrf || typeof supplied !== "string" || !equal(supplied, csrf)) throw new HttpError(403, "CSRF 令牌无效");
        if (Object.keys(body).some(key => key !== "_csrf")) throw new HttpError(400, "此操作不接受额外字段");
      } else await validateDashboardPost(req, host, csrf);
      if (!service) throw new HttpError(404, "事件服务未启用");
      const match = /^\/(?:api\/)?events\/([A-Za-z][A-Za-z0-9_:-]{0,63})\/(pause|resume|poll)$/.exec(url.pathname);
      if (!match) throw new HttpError(404, "接口不存在");
      const [, id, action] = match;
      if (action === "pause") await service.pause(id);
      else if (action === "resume") await service.resume(id);
      else await service.pollNow(id);
      if (api) json(res, 200, { source: id, action }); else res.writeHead(303, { Location: "/events" }).end();
    } catch (error) {
      const expected = error instanceof HttpError || error instanceof EventManagementError;
      const status = expected ? error.status : 500, message = expected ? error.message : "事件操作失败";
      if (api) json(res, status, { error: message });
      else res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(page({ title: "事件操作未完成", path: "/events", nonce,
        flash: { text: message, error: true }, body: '<p><a href="/events">返回事件页</a></p>' }));
    }
  };
}
