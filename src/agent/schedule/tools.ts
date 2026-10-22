import type { Harness } from "@earendil-works/pi-durable";
import { trace, type Trace } from "../../shared/trace.js";
import type { ScheduleTool, ScheduleToolPermissions } from "../../shared/schedule-tools.js";
import type { GrantBinding, GrantsService } from "../grants.js";
import { readScheduledRun } from "./run.js";
import type { ScheduleService } from "./service.js";
import type { Schedule, ScheduleConversation } from "./types.js";
import { formatBeijingTime, parseToolRule, scheduleInputs } from "./tool-schema.js";

const summary = (schedule: Schedule) =>
  `${schedule.id} · ${schedule.name} · 状态：${{ active: "启用", paused: "暂停", completed: "已完成" }[schedule.status]}（${schedule.status}）· 下次：${schedule.next_fire_at === null ? "无" : formatBeijingTime(schedule.next_fire_at) + "（北京时间）"}`;

/** pi 与 codex 共用的执行入口；不信任模型参数或工具可见性，逐次按会话宿主的本轮身份复核当前授权。 */
export class ScheduleTools {
  constructor(private readonly opts: {
    grants: GrantsService;
    getHarness(): Harness;
    getSchedules(): ScheduleService;
    now?: () => number;
    trace?: Pick<Trace, "event">;
  }) {}

  /**
   * 身份经 grants.identity（runRights，§7.3）：只有会话基础权限的回合不能使用定时工具；
   * 定时身份只能控制本次运行的任务（须有本轮的定时输入绑定，继承了定时身份的唤醒回合没有）。
   */
  private async access(binding: GrantBinding) {
    const identity = this.opts.grants.identity(binding);
    if (!identity) throw new Error("本轮只有会话基础权限，不能使用定时工具");
    // 会话即线程键：owner 私聊为 owner，群与其他私聊为来源 scope。
    const conversation = (identity.actorIsOwner && identity.scope.startsWith("private:") ? "owner" : identity.scope) as ScheduleConversation;
    if (identity.origin === "scheduled") {
      let run: Awaited<ReturnType<typeof readScheduledRun>>;
      for (const key of binding.inputs) run ??= await readScheduledRun(this.opts.getHarness(), key);
      if (!run || run.created_by !== identity.actor ||
          (run.conversation === "owner" ? !identity.actorIsOwner || !identity.scope.startsWith("private:") : run.conversation !== identity.scope)) {
        throw new Error("定时回合缺少有效的任务绑定");
      }
      return { ...identity, conversation, scheduleId: run.schedule_id, management: false };
    }
    return { ...identity, conversation, scheduleId: undefined,
      management: await this.opts.grants.canSchedule(identity.actor, conversation) };
  }

  async permissions(binding: GrantBinding): Promise<ScheduleToolPermissions> {
    const identity = this.opts.grants.identity(binding);
    if (!identity || (identity.origin === "scheduled" && !binding.inputs.length)) return { schedule: false, scheduleControl: false };
    const access = await this.access(binding);
    return { schedule: access.management, scheduleControl: access.scheduleId !== undefined };
  }

  async tool(binding: GrantBinding, name: ScheduleTool, input: unknown): Promise<string> {
    const access = await this.access(binding), service = this.opts.getSchedules();
    let id: string | null = null, action: string = name.slice("schedule_".length), reason: string | undefined, text: string;
    if (name === "schedule_control") {
      if (!access.scheduleId) throw new Error("schedule_control 仅限定时运行自己的任务");
      const args = scheduleInputs.control.parse(input);
      id = access.scheduleId; action = args.action; reason = args.reason;
      text = summary(args.action === "pause" ? await service.pause(access.actor, id, args.reason) : await service.complete(access.actor, id));
    } else {
      if (!access.management) throw new Error("定时管理工具仅限具有 schedule 授权的交互回合");
      if (name === "schedule_create") {
        const args = scheduleInputs.create.parse(input);
        const schedule = await service.create(access.actor, {
          ...args, rule: parseToolRule(args.rule, (this.opts.now ?? Date.now)()), conversation: access.conversation,
        });
        id = schedule.id; text = summary(schedule);
      } else if (name === "schedule_list") {
        scheduleInputs.list.parse(input);
        text = (await service.list(access.actor)).map(summary).join("\n") || "没有可见的定时任务。";
      } else if (name === "schedule_update") {
        const { id: target, rule, ...patch } = scheduleInputs.update.parse(input);
        id = target;
        text = summary(await service.update(access.actor, id, {
          ...patch, ...(rule ? { rule: parseToolRule(rule, (this.opts.now ?? Date.now)()) } : {}),
        }));
      } else {
        id = scheduleInputs.id.parse(input).id;
        if (name === "schedule_delete") {
          await service.remove(access.actor, id); text = `${id} · 状态：已删除 · 下次：无`;
        } else if (name === "schedule_run_now") {
          const run = await service.runNow(access.actor, id);
          const schedule = await service.get(id, access.actor);
          text = `${schedule ? summary(schedule) : `${id} · 状态：已删除 · 下次：无`}；本次运行：${run.status}`;
        } else {
          text = summary(name === "schedule_pause" ? await service.pause(access.actor, id) : await service.resume(access.actor, id));
        }
      }
    }
    (this.opts.trace ?? trace).event(binding.turnId ? "turn:" + binding.turnId : "thr:" + binding.threadKey, "schedule_tool", { detail: {
      action, id, actor: access.actor, tool: name, ...(reason ? { reason } : {}),
    } });
    return text;
  }
}
