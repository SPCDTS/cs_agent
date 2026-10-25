/** 定时任务 JSON 管理接口；身份来自已鉴权的面板 owner，不接受请求体自报身份。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ScheduleService } from "../agent/schedule/service.js";
import { ScheduleError } from "../agent/schedule/model.js";
import { equal, guardDashboardOrigin, HttpError } from "./dashboard-io.js";
import { log } from "../shared/log.js";

export type ScheduleManagement = Pick<ScheduleService, "list" | "pause" | "resume" | "runNow" | "remove">;
const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "只接受 application/json");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) { req.resume(); throw new HttpError(413, "提交内容过大"); }
    chunks.push(bytes);
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new HttpError(400, "请求体必须是 JSON 对象"); }
}

export function createScheduleRoutes(service: ScheduleManagement | undefined, owner: string | undefined, csrf: string) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, host: string): Promise<void> => {
    try {
      if (!service || !owner) throw new HttpError(404, "定时任务管理未启用");
      const actor = `qq:${owner}`;
      if (req.method === "GET") {
        if (url.pathname !== "/api/schedules") throw new HttpError(404, "接口不存在");
        json(res, 200, { schedules: await service.list(actor), csrf }); return;
      }
      guardDashboardOrigin(req, host);
      const body = await readJson(req);
      const supplied = req.headers["x-csrf-token"] ?? body._csrf;
      if (!csrf || typeof supplied !== "string" || !equal(supplied, csrf)) throw new HttpError(403, "CSRF 令牌无效，请刷新页面后重试");
      delete body._csrf;
      const match = /^\/api\/schedules\/([a-zA-Z0-9_-]+)\/(pause|resume|run|delete)$/.exec(url.pathname);
      if (!match) throw new HttpError(404, "接口不存在");
      const [, id, action] = match;
      if (Object.keys(body).length) throw new HttpError(400, "此操作不接受额外字段");
      if (action === "pause") json(res, 200, { schedule: await service.pause(actor, id) });
      else if (action === "resume") json(res, 200, { schedule: await service.resume(actor, id) });
      else if (action === "run") json(res, 200, { run: await service.runNow(actor, id) });
      else { await service.remove(actor, id); json(res, 200, { deleted: id }); }
    } catch (error) {
      const expected = error instanceof ScheduleError || error instanceof HttpError;
      if (!expected) log.error("schedule API failed", { error });
      json(res, expected ? error.status : 500, { error: expected ? error.message : "操作失败，详见日志" });
    }
  };
}
