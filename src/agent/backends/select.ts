/**
 * 后端选择（设计 §4.3）：AGENT_BACKEND（全局默认 codex），AGENT_BACKEND_OVERRIDES 按 scope 覆盖，
 * 例如 `group:200000001=pi,private:10000001=codex`。切换只影响之后处理的消息。
 */
import { isScope } from "../../context/access.js";
import { BACKEND_NAMES, type AgentBackend, type BackendName } from "./types.js";

export function isBackendName(v: unknown): v is BackendName {
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

export const PI_NOT_IMPLEMENTED = "pi backend not implemented yet (group 3)";

/** pi 后端占位（第 3 组实现）：选中时每次调用都抛错，agent 任务回复失败模板。 */
export class PiBackendStub implements AgentBackend {
  readonly name = "pi" as const;
  async handle(): Promise<never> {
    throw new Error(PI_NOT_IMPLEMENTED);
  }
}

export interface BackendSelector {
  select(scope: string): AgentBackend;
}

export function createBackendSelector(opts: {
  defaultBackend: BackendName;
  overrides: Readonly<Record<string, BackendName>>;
  backends: Partial<Record<BackendName, AgentBackend>>;
}): BackendSelector {
  return {
    select(scope) {
      const name = backendNameFor(scope, opts.defaultBackend, opts.overrides);
      const backend = opts.backends[name];
      if (!backend) throw new Error(`agent backend "${name}" is not registered`);
      return backend;
    },
  };
}
