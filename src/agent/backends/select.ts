/**
 * 后端选择（docs/ARCHITECTURE.md §2.4）：AGENT_BACKEND（全局默认 codex），AGENT_BACKEND_OVERRIDES 按 scope 覆盖，
 * 例如 `group:200000001=pi,private:10000001=codex`。切换只影响之后处理的消息。
 */
import { isScope } from "../../context/access.js";
import { BACKEND_NAMES, type AgentBackend, type BackendName } from "./types.js";

function isBackendName(v: unknown): v is BackendName {
  return typeof v === "string" && (BACKEND_NAMES as readonly string[]).includes(v);
}

/** 解析覆盖表；非法项抛出带说明的错误（配置期失败，不静默忽略）。 */
export function parseBackendOverrides(raw: string | undefined): Record<string, BackendName> {
  const out: Record<string, BackendName> = {};
  for (const item of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = item.lastIndexOf("=");
    const scope = eq > 0 ? item.slice(0, eq).trim() : "";
    const backend = eq > 0 ? item.slice(eq + 1).trim() : "";
    if (!isScope(scope)) throw new Error(`AGENT_BACKEND_OVERRIDES 项 "${item}" 的 scope 非法（应为 group:<群号> 或 private:<QQ号>）`);
    if (!isBackendName(backend)) throw new Error(`AGENT_BACKEND_OVERRIDES 项 "${item}" 的后端非法（应为 ${BACKEND_NAMES.join(" | ")}）`);
    out[scope] = backend;
  }
  return out;
}

export function backendNameFor(scope: string, defaultBackend: BackendName, overrides: Readonly<Record<string, BackendName>>): BackendName {
  return overrides[scope] ?? defaultBackend;
}

