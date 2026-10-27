import { isMemoryOperation, type MemoryOperation } from "../../shared/memory-tools.js";
/**
 * 记忆服务（docs/MEMORY-DESIGN.md §5、§6）：按本轮权限（host/identity.ts 的 runRights）求出命名空间的可读集与可写集，
 * 执行 mem_* 内部操作的语义，写 trace 事件 memory_recall / memory_write。pi 工具与 codex 的 im MCP（经 loopback）都调这里，
 * 每次调用都重新求权限，不信任调用方传来的范围。面板的遗忘 / 恢复也经这里，作者记为 dashboard。
 */
import type { InboundRecord, TurnBinding } from "../../channel/types.js";
import { ProfileError, type ProfileStore } from "../../context/memory/profile.js";
import { MemoryStoreError, type MemoryStore } from "../../context/memory/store.js";
import { MEMORY_ACTIVE_SOFT_CAP, isMemoryNs, type MemoryKind, type MemoryRow, type MemoryScope, type MemoryStatus } from "../../context/memory/types.js";
import { scopeLabel } from "../../context/access.js";
import { log } from "../../shared/log.js";
import type { OwnerIds } from "../../shared/owners.js";
import { trace as defaultTrace, type Trace } from "../../shared/trace.js";
import { containsSecret } from "../../shared/redact.js";
import { isEventTurn, runRights, type RunRights } from "../host/identity.js";
import { formatMemoryLine, renderMemorySection } from "./render.js";
import { MEMORY_READ_TOOLS, MEMORY_WRITE_TOOLS, memoryInputs, parseClearableTime, parseMemoryTime, type MemoryTool } from "./tools.js";

/** 本轮的记忆范围：read 为可读命名空间（all = 全部），write 为可写命名空间，profile 为可改画像的命名空间。 */
export interface MemoryAccess {
  read: MemoryScope;
  write: readonly string[];
  /** owner 私聊：subject 写成 group:<id> / private:<qq> 时记入该会话，并可管理任意命名空间的条目 */
  routeSubjects: boolean;
  profile?: string;
}

/**
 * §5 的权限表：
 * - owner 私聊且读全部（owner 本人）：读全部，写 owner（subject 指向别的会话时写那里）；
 * - 群线程（任何人，含 owner）：读写本群；其他私聊：读写本人；
 * - 本轮没有确证的人：读同上，不可写；子 agent：只读。画像只在 owner 本人的回合、只写本线程的命名空间。
 */
export function memoryAccess(rights: RunRights, child = false): MemoryAccess {
  const ns = rights.threadKey;
  if (!isMemoryNs(ns)) return { read: [], write: [], routeSubjects: false };
  const read: MemoryScope = rights.access === "all" ? "all" : [ns];
  if (child || !rights.person) return { read, write: [], routeSubjects: false };
  if (isEventTurn(rights)) return { read, write: ns === "owner" && rights.owner ? ["owner"] : [], routeSubjects: false };
  if (ns === "owner") return rights.owner && rights.access === "all" ? { read, write: ["owner"], routeSubjects: true, profile: "owner" }
    : { read, write: [], routeSubjects: false };
  return { read, write: [ns], routeSubjects: false, ...(rights.owner ? { profile: ns } : {}) };
}

/** 本轮可见的工具：读工具恒有；有可写命名空间才有写工具；画像工具只在 owner 本人的回合。 */
export function memoryToolNames(access: MemoryAccess): MemoryTool[] {
  return [...MEMORY_READ_TOOLS, ...(access.write.length ? MEMORY_WRITE_TOOLS : []), ...(access.profile ? ["mem_profile" as const] : [])];
}

export const MEMORY_UNVERIFIED = "本轮身份未确证，不能写入记忆";
export const MEMORY_CHILD_READONLY = "子 agent 只能检索记忆，不能写入";
export const MEMORY_PROFILE_OWNER_ONLY = "画像只能在 owner 本人的回合修改";
/** 每轮工具写入上限（§11） */
export const MEMORY_WRITES_PER_TURN = 20;

/** 工具调用的绑定：会话宿主给出的本轮绑定；child 为子 agent 会话。backend / session 只用于观测归属。 */
export interface MemoryBinding extends TurnBinding {
  child?: boolean;
  backend?: "pi" | "codex";
  session?: string;
}

export interface MemoryServiceOptions {
  store: MemoryStore;
  profiles: ProfileStore;
  owners: OwnerIds | (() => OwnerIds);
  /** 本轮最后一条输入 → 来源会话与消息 id */
  inbound?: (key: string) => Pick<InboundRecord, "scope" | "message_id"> | null;
  /** 来源会话的显示名（群名、owner 私聊） */
  scopeLabel?: (scope: string) => string;
  /** 工具输出总量上限（QQ_CONTEXT_MAX_CHARS） */
  maxChars?: number;
  trace?: Pick<Trace, "event">;
}

/**
 * 写入新条目后检查命名空间的 active 条目软上限（§11）：超过只告警、不拒写，每个 warned 集合按命名空间只告警一次。
 * 显式工具（mem_remember）与回合后抽取两条写入路径共用。
 */
export function warnActiveSoftCap(store: Pick<MemoryStore, "activeCount">, ns: string, warned: Set<string>): void {
  if (warned.has(ns)) return;
  const count = store.activeCount(ns);
  if (count <= MEMORY_ACTIVE_SOFT_CAP) return;
  warned.add(ns);
  log.warn("memory active entries over soft cap", { ns, count, cap: MEMORY_ACTIVE_SOFT_CAP });
}

export class MemoryError extends Error {
  constructor(message: string) { super(message); this.name = "MemoryError"; }
}

const traceKeyOf = (b: Pick<TurnBinding, "turnId" | "threadKey">) => b.turnId ? "turn:" + b.turnId : "thr:" + b.threadKey;
const NS_SUBJECT = /^(?:group|private):[1-9][0-9]{0,19}$/;

export class MemoryService {
  private readonly writes = new Map<string, number>();
  private readonly capWarned = new Set<string>();

  constructor(private readonly opts: MemoryServiceOptions) {}

  private get tracer() { return this.opts.trace ?? defaultTrace; }
  private owners(): OwnerIds { return typeof this.opts.owners === "function" ? this.opts.owners() : this.opts.owners; }
  /** 来源会话的显示名（工具输出与面板共用） */
  label(scope: string): string { return (this.opts.scopeLabel ?? scopeLabel)(scope); }
  private maxChars(): number { return Math.min(2500, this.opts.maxChars ?? 2500); }

  /** 本轮记忆范围：每次调用按宿主绑定重新求 runRights。 */
  access(binding: MemoryBinding): MemoryAccess {
    return memoryAccess(runRights(binding, this.owners()), binding.child === true);
  }

  /** 本轮应注册的工具（pi 每轮按它选扩展）。 */
  toolNames(binding: MemoryBinding): MemoryTool[] { return memoryToolNames(this.access(binding)); }

  /** 两个后端共用的提示段；空画像且无承诺时为 undefined。 */
  render(ns: string): Promise<string | undefined> {
    return renderMemorySection(this.opts, ns);
  }

  /** 执行一个 mem_* 工具，返回文本；参数或权限不符抛 MemoryError（调用方作为工具错误返回）。 */
  async tool(binding: MemoryBinding, name: string, args: unknown): Promise<string> {
    if (!isMemoryOperation(name)) throw new MemoryError("未知的记忆工具：" + name);
    const rights = runRights(binding, this.owners()), access = memoryAccess(rights, binding.child === true);
    try {
      switch (name) {
        case "mem_search": return this.search(binding, access, memoryInputs.mem_search.parse(args ?? {}));
        case "mem_list": return this.list(binding, access, memoryInputs.mem_list.parse(args ?? {}));
        case "mem_profile": return await this.profile(binding, rights, access, memoryInputs.mem_profile.parse(args ?? {}));
        default: {
          this.ensureWritable(binding, rights, access);
          const text = name === "mem_remember" ? this.remember(binding, rights, access, memoryInputs.mem_remember.parse(args ?? {}))
            : name === "mem_update" ? this.update(binding, rights, access, memoryInputs.mem_update.parse(args ?? {}))
            : this.forget(binding, rights, access, memoryInputs.mem_forget.parse(args ?? {}));
          return text;
        }
      }
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      if (error instanceof MemoryStoreError || error instanceof ProfileError) throw new MemoryError(error.message);
      if (error && typeof error === "object" && "issues" in error && Array.isArray((error as { issues: unknown[] }).issues)) {
        const issues = (error as { issues: { path: PropertyKey[]; message: string }[] }).issues;
        throw new MemoryError("参数无效：" + issues.map(i => (i.path.length ? i.path.join(".") + " " : "") + i.message).join("；"));
      }
      throw error;
    }
  }

  // ───────────── 读 ─────────────

  private lines(rows: readonly MemoryRow[], empty: string): { text: string; shown: MemoryRow[] } {
    if (!rows.length) return { text: empty, shown: [] };
    const max = this.maxChars(), out: string[] = [], shown: MemoryRow[] = [];
    let used = 0;
    for (const row of rows) {
      const line = formatMemoryLine(row, scope => this.label(scope));
      const tail = rows.length - shown.length - 1 > 0 ? 40 : 0;
      if (used + line.length + 1 + tail > max) break;
      out.push(line); shown.push(row); used += line.length + 1;
    }
    if (shown.length < rows.length) out.push(`（另有 ${rows.length - shown.length} 条未显示，请缩小范围）`);
    return { text: out.join("\n"), shown };
  }

  private recall(binding: MemoryBinding, tool: MemoryOperation, hits: readonly MemoryRow[], shown: readonly MemoryRow[], chars: number): void {
    this.tracer.event(traceKeyOf(binding), "memory_recall", { detail: { backend: binding.backend, session: binding.session, tool,
      ids: shown.map(r => r.id), returned_count: shown.length, dropped_count: hits.length - shown.length, chars,
      max_chars: this.maxChars() } });
  }

  private search(binding: MemoryBinding, access: MemoryAccess, args: { query: string; kind?: MemoryKind; subject?: string; status?: MemoryStatus; limit?: number }): string {
    const rows = this.opts.store.search({ scope: access.read, query: args.query, kind: args.kind, subject: args.subject, status: args.status, limit: args.limit ?? 10 });
    const { text, shown } = this.lines(rows, "没有找到匹配的记忆。");
    this.opts.store.touchRecall(shown.map(r => r.id));
    this.recall(binding, "mem_search", rows, shown, text.length);
    return text;
  }

  private list(binding: MemoryBinding, access: MemoryAccess, args: { kind?: MemoryKind; subject?: string; status?: MemoryStatus; limit?: number }): string {
    const rows = this.opts.store.list({ scope: access.read, kind: args.kind, subject: args.subject, status: args.status, limit: args.limit ?? 20 });
    const { text, shown } = this.lines(rows, "没有记忆条目。");
    this.recall(binding, "mem_list", rows, shown, text.length);
    return text;
  }

  // ───────────── 写 ─────────────

  private ensureWritable(binding: MemoryBinding, rights: RunRights, access: MemoryAccess): void {
    if (binding.child) throw new MemoryError(MEMORY_CHILD_READONLY);
    if (!rights.person || !access.write.length) throw new MemoryError(MEMORY_UNVERIFIED);
    const key = traceKeyOf(binding), used = this.writes.get(key) ?? 0;
    const limit = isEventTurn(rights) ? 5 : MEMORY_WRITES_PER_TURN;
    if (used >= limit) throw new MemoryError(`本轮写入记忆已达上限（${limit} 次）`);
    this.writes.delete(key); this.writes.set(key, used + 1);
    if (this.writes.size > 1000) this.writes.delete(this.writes.keys().next().value!);
  }

  private canWrite(access: MemoryAccess, ns: string): boolean {
    return access.write.includes(ns) || (access.routeSubjects && isMemoryNs(ns));
  }

  private writable(access: MemoryAccess, id: number): MemoryRow {
    const row = this.opts.store.get(id);
    // 读不到与无权写同一提示，不暴露别的命名空间里是否有这个 id。
    if (!row || !this.canWrite(access, row.ns)) throw new MemoryError(`没有可修改的记忆 #${id}`);
    return row;
  }

  private checkSecret(...texts: (string | undefined)[]): void {
    if (texts.some(t => t !== undefined && containsSecret(t))) throw new MemoryError("内容包含凭据样式的信息，拒绝写入记忆");
  }

  private written(binding: MemoryBinding, tool: MemoryOperation, rights: RunRights, row: MemoryRow, extra: Record<string, unknown> = {}): void {
    this.tracer.event(traceKeyOf(binding), "memory_write", { detail: { backend: binding.backend, session: binding.session, tool,
      author: rights.actor, id: row.id, ns: row.ns, kind: row.kind, status: row.status, ...extra } });
  }

  private remember(binding: MemoryBinding, rights: RunRights, access: MemoryAccess,
    args: { text: string; kind: MemoryKind; subject?: string; since?: string; due_at?: string; supersedes?: number }): string {
    this.checkSecret(args.text, args.subject);
    const ns = access.routeSubjects && args.subject && NS_SUBJECT.test(args.subject) ? args.subject : access.write[0]!;
    if (args.due_at !== undefined && args.kind !== "commitment") throw new MemoryError("due_at 只用于 commitment");
    const source = binding.inputKey ? this.opts.inbound?.(binding.inputKey) ?? null : null;
    const result = this.opts.store.remember({
      ns, kind: args.kind, text: args.text, subject: args.subject ?? null,
      since: args.since !== undefined ? parseMemoryTime(args.since) : null, due_at: args.due_at !== undefined ? parseMemoryTime(args.due_at) : null,
      author: rights.actor!, source_scope: source?.scope ?? binding.scope, source_message_id: source?.message_id || null,
      source_turn_id: binding.turnId ?? null, confidence: 1,
    }, args.supersedes !== undefined ? { supersedes: args.supersedes } : {});
    const line = formatMemoryLine(result.row, scope => this.label(scope)), replaced = result.superseded ? `（取代 #${result.superseded.id}）` : "";
    if (result.superseded || !result.duplicate) this.written(binding, "mem_remember", rights, result.row, { superseded: result.superseded?.id ?? null, duplicate: result.duplicate });
    if (result.duplicate) return "已有相同的记忆，未重复记录：" + line + replaced;
    warnActiveSoftCap(this.opts.store, ns, this.capWarned);
    return "已记住：" + line + replaced;
  }

  private update(binding: MemoryBinding, rights: RunRights, access: MemoryAccess,
    args: { id: number; text?: string; subject?: string; until?: string; due_at?: string; done_at?: string }): string {
    const row = this.writable(access, args.id);
    if (row.status !== "active") throw new MemoryError(`记忆 #${row.id} 已是 ${row.status}，只能修改 active 条目`);
    if ((args.due_at || args.done_at) && row.kind !== "commitment") throw new MemoryError("due_at / done_at 只用于 commitment");
    this.checkSecret(args.text, args.subject);
    const after = this.opts.store.update(row.id, {
      ...(args.text !== undefined ? { text: args.text } : {}), ...(args.subject !== undefined ? { subject: args.subject || null } : {}),
      until: parseClearableTime(args.until), due_at: parseClearableTime(args.due_at), done_at: parseClearableTime(args.done_at),
    }, rights.actor!, "mem_update");
    this.written(binding, "mem_update", rights, after);
    return "已更新：" + formatMemoryLine(after, scope => this.label(scope));
  }

  private forget(binding: MemoryBinding, rights: RunRights, access: MemoryAccess, args: { id: number; reason: string }): string {
    const row = this.writable(access, args.id);
    this.checkSecret(args.reason);
    if (row.status === "forgotten") return `记忆 #${row.id} 已是遗忘状态。`;
    const after = this.opts.store.setStatus(row.id, "forgotten", rights.actor!, args.reason);
    this.written(binding, "mem_forget", rights, after);
    return `已遗忘 #${row.id}（只做标记，owner 可在面板恢复）。`;
  }

  private async profile(binding: MemoryBinding, rights: RunRights, access: MemoryAccess, args: { text: string; revision: string }): Promise<string> {
    if (binding.child || !access.profile) throw new MemoryError(MEMORY_PROFILE_OWNER_ONLY);
    // 画像写入与条目写入共用每轮写入额度
    this.ensureWritable(binding, rights, access);
    try {
      const { revision } = await this.opts.profiles.write(access.profile, args.text, args.revision);
      this.tracer.event(traceKeyOf(binding), "memory_write", { detail: { backend: binding.backend, session: binding.session, tool: "mem_profile",
        author: rights.actor, ns: access.profile, bytes: Buffer.byteLength(args.text, "utf8") } });
      return `画像已保存（revision=${revision}），下一轮起进入提示。`;
    } catch (error) {
      if (error instanceof ProfileError && error.code === "stale") {
        const current = await this.opts.profiles.read(access.profile);
        const head = current.oversize
          ? `当前画像超过 4 KiB 上限，没有进入提示，请重写为 4 KiB 以内；当前 revision=${current.revision}，当前内容如下：\n`
          : `画像已被修改，当前 revision=${current.revision}，当前内容如下；在此基础上修改后重新提交：\n`;
        // 整段错误文本同样受工具输出上限约束
        const room = this.maxChars() - head.length, cut = "\n…（已截断）", chars = [...current.text];
        throw new MemoryError(head + (chars.length > room ? chars.slice(0, Math.max(0, room - cut.length)).join("") + cut : current.text));
      }
      throw error;
    }
  }

  // ───────────── 面板（owner 运维口令） ─────────────

  /** 面板遗忘：作者记为 dashboard。 */
  forgetFromDashboard(id: number, reason = "面板遗忘"): MemoryRow {
    const row = this.opts.store.get(id);
    if (!row) throw new MemoryError(`记忆 #${id} 不存在`);
    if (row.status === "forgotten") return row;
    const after = this.opts.store.setStatus(id, "forgotten", "dashboard", reason);
    this.tracer.event("@memory", "memory_write", { detail: { tool: "dashboard_forget", author: "dashboard", id, ns: row.ns, kind: row.kind, status: after.status } });
    return after;
  }

  /**
   * 面板编辑画像（§10）：整体替换，CAS；超限、含凭据样式内容与 revision 不符由 ProfileStore 拒绝（ProfileError，code 为 invalid / secret / stale）。
   * 作者记为 dashboard，写 @memory 的 memory_write 事件（只记字节数，不记正文）。
   */
  async saveProfileFromDashboard(ns: string, text: string, revision: string): Promise<{ revision: string }> {
    if (!isMemoryNs(ns)) throw new ProfileError("命名空间无效");
    const result = await this.opts.profiles.write(ns, text, revision);
    this.tracer.event("@memory", "memory_write", { detail: { tool: "dashboard_profile", author: "dashboard", ns, bytes: Buffer.byteLength(text, "utf8") } });
    return result;
  }

  /** 面板恢复：回到遗忘前的状态（查不到为 active）。 */
  restoreFromDashboard(id: number): MemoryRow {
    const row = this.opts.store.get(id);
    if (!row) throw new MemoryError(`记忆 #${id} 不存在`);
    if (row.status !== "forgotten") throw new MemoryError(`记忆 #${id} 未被遗忘，无需恢复`);
    const after = this.opts.store.setStatus(id, this.opts.store.statusBeforeForget(id), "dashboard", "面板恢复");
    this.tracer.event("@memory", "memory_write", { detail: { tool: "dashboard_restore", author: "dashboard", id, ns: row.ns, kind: row.kind, status: after.status } });
    return after;
  }
}
