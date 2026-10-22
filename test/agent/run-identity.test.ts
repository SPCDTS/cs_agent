/**
 * 回合绑定一个人（设计 §7.3）：会话基础权限 + 只在确证时叠加的人；唤醒回合继承派出子 agent 那一轮的人。
 */
import { describe, expect, it } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { base, elevation, mergePersons, runRights, type RunPerson } from "../../src/agent/host/identity.js";
import { SUBAGENT_REPORT_KIND, SUBAGENT_REPORT_REQUEST_PREFIX, SubagentDoc, type SubagentReportData } from "../../src/agent/pi-tools/subagent.js";
import type { PiCallBinding } from "../../src/agent/pi-tools/request.js";
import type { TurnIdentity } from "../../src/channel/types.js";
import { grantsFixture } from "./grants-fixture.js";
import { call, context, gate, isChild, lastUser, reply, residentRig, toolResults, type Brain, type ResidentRig } from "./resident-fixture.js";
import { scheduleToolsFixture } from "./schedule-tools-fixture.js";

const OWNERS = ["1", "9"];
const owner1: RunPerson = { kind: "user", person: "1", owner: true };
const member5: RunPerson = { kind: "user", person: "5", owner: false };
const wake = (inherited?: RunPerson): TurnIdentity => ({ kind: "wake", ...(inherited ? { inherited } : {}) });

describe("身份两层：base + elevation", () => {
  it("用户与定时回合确证为本人；owner 只在私聊线程读全部，群里只读本群；授权工具只给 owner 的交互身份", () => {
    expect(runRights({ threadKey: "group:7", scope: "group:7", identity: { kind: "user", sender: "1" } }, OWNERS))
      .toEqual({ threadKey: "group:7", scope: "group:7", person: owner1, actor: "qq:1", access: "group:7", owner: true, auth: true });
    expect(runRights({ threadKey: "owner", scope: "private:1", identity: { kind: "user", sender: "1" } }, OWNERS)).toMatchObject({ access: "all" });
    expect(runRights({ threadKey: "group:7", scope: "group:7", identity: { kind: "user", sender: "5" } }, OWNERS))
      .toMatchObject({ person: member5, access: "group:7", owner: false, auth: false });
    expect(runRights({ threadKey: "owner", scope: "private:1", identity: { kind: "scheduled", creator: "1" } }, OWNERS))
      .toMatchObject({ person: { kind: "scheduled", person: "1", owner: true }, access: "all", owner: true, auth: false });
  });

  it("唤醒回合继承确证的人；没有继承或形状不对只有基础权限；owner 标记只降不升", () => {
    const owner = { threadKey: "owner", scope: "private:1" };
    expect(runRights({ ...owner, identity: wake(owner1) }, OWNERS)).toMatchObject({ person: owner1, access: "all", owner: true, auth: true });
    // owner 线程不再有例外：没有继承身份就只有基础权限
    expect(runRights({ ...owner, identity: wake() }, OWNERS)).toEqual({ ...base("owner", "private:1") });
    expect(base("owner", "private:1")).toEqual({ threadKey: "owner", scope: "private:1", access: "private:1", owner: false, auth: false });
    for (const bad of [{ kind: "user", person: "01", owner: true }, { kind: "admin", person: "1", owner: true }, { kind: "user", person: "1" }, null]) {
      expect(elevation(wake(bad as RunPerson), OWNERS)).toBeUndefined();
    }
    // 快照与当前 owner 配置不一致（之后被加入或移出 owner）→ 基础权限（下游按 actor 重新判断 owner 的地方不会与快照冲突）
    expect(elevation(wake({ kind: "user", person: "1", owner: false }), OWNERS)).toBeUndefined();
    expect(elevation(wake({ kind: "user", person: "5", owner: true }), OWNERS)).toBeUndefined();
    expect(() => base("group:7", "all")).toThrow("地址");
  });

  it("多份身份合并：同一人同一类型才保留（owner 多账号算同一人），否则基础权限", () => {
    expect(mergePersons([member5, member5])).toEqual(member5);
    expect(mergePersons([owner1, { kind: "user", person: "9", owner: true }])).toEqual(owner1);
    expect(mergePersons([member5, { kind: "user", person: "6", owner: false }])).toBeUndefined();
    expect(mergePersons([owner1, { kind: "scheduled", person: "1", owner: true }])).toBeUndefined();
    expect(mergePersons([member5, undefined])).toBeUndefined();
    expect(mergePersons([])).toBeUndefined();
  });
});

describe("每条权限路径都经统一函数：基础权限不能越过 base", () => {
  it("发送 target：基础权限拒绝（含 owner 会话）；继承 owner 可发；继承成员按其授权", async () => {
    const f = await grantsFixture("1", false, OWNERS);
    await expect(f.service.send({ ...f.binding, identity: wake() }, { target: "qq:group:8", text: "越权" }, "b")).rejects.toThrow("基础权限");
    expect((await f.service.send({ ...f.binding, identity: wake(owner1) }, { target: "qq:group:8", text: "owner 唤醒" }, "o")).status).toBe("sent");
    const m = { ...f.binding, identity: wake({ kind: "user", person: "5", owner: false }) };
    await expect(f.service.send(m, { target: "qq:group:8", text: "成员" }, "m1")).rejects.toThrow("授权");
    await f.grants.panel("auth_grant", { user: "qq:5", caps: ["send"], targets: ["qq:group:8"] });
    expect((await f.service.send(m, { target: "qq:group:8", text: "成员" }, "m2")).status).toBe("sent");
    // 伪造的 owner 标记不能升权
    expect(await f.grants.permissions({ ...f.binding, identity: wake({ kind: "user", person: "6", owner: true }) })).toEqual({ actorIsOwner: false, target: false, auth: false });
  });

  it("授权工具：基础权限与定时身份拒绝；只有继承自 owner 交互回合的唤醒可用", async () => {
    const f = await grantsFixture("1", false, OWNERS);
    await expect(f.grants.tool({ ...f.binding, identity: wake() }, "auth_list", {})).rejects.toThrow("owner");
    await expect(f.grants.tool({ ...f.binding, identity: wake({ kind: "scheduled", person: "1", owner: true }) }, "auth_list", {})).rejects.toThrow("owner");
    await expect(f.grants.tool({ ...f.binding, identity: wake(member5) }, "auth_list", {})).rejects.toThrow("owner");
    expect(await f.grants.tool({ ...f.binding, identity: wake(owner1) }, "auth_list", {})).toEqual([]);
    expect(await f.grants.permissions({ ...f.binding, identity: wake(owner1) })).toEqual({ actorIsOwner: true, target: true, auth: true });
  });

  it("定时工具：基础权限没有；继承成员按其 schedule 授权；继承定时身份没有本次运行绑定，什么都不开放", async () => {
    const f = await scheduleToolsFixture();
    const b = f.binding("9");
    expect(await f.tools.permissions({ ...b, identity: wake() })).toEqual({ schedule: false, scheduleControl: false });
    await expect(f.tools.tool({ ...b, identity: wake() }, "schedule_list", {})).rejects.toThrow("基础权限");
    const member = { ...b, identity: wake({ kind: "user", person: "9", owner: false }) };
    expect(await f.tools.permissions(member)).toEqual({ schedule: false, scheduleControl: false });
    await f.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"], scopes: ["group:7"] });
    expect(await f.tools.permissions(member)).toEqual({ schedule: true, scheduleControl: false });
    const scheduled = { ...b, identity: wake({ kind: "scheduled", person: "1", owner: true }) };
    expect(await f.tools.permissions(scheduled)).toEqual({ schedule: false, scheduleControl: false });
    await expect(f.tools.tool(scheduled, "schedule_control", { action: "complete", reason: "x" })).rejects.toThrow();
  });
});

// ───────────── pi 常驻：派出者身份随汇报带回 ─────────────

const SEND_GRANT = { user: "qq:5", caps: ["send"], targets: ["qq:group:8"] };

async function conversation(r: ResidentRig, key = "group:7") {
  const id = (await r.pi.readThreadIds())[key];
  // 不能把 undefined 交给 harness：存储报错会让整个 Session 失效
  if (id === undefined) throw new Error("会话尚未创建");
  return (await r.pi.harness.conversation(id as ConversationId, context))!;
}

/** 父会话脚本：用户说"派"就派子 agent w；汇报交给 onWake；工具结果收集到 results。 */
function script(onWake: (input: string, ctx: Parameters<Brain>[0], signal: AbortSignal | undefined) => ReturnType<Brain>,
  results: string[][], child: (ctx: Parameters<Brain>[0]) => string = () => "晴"): Brain {
  return (ctx, signal) => {
    if (isChild(ctx)) return reply(child(ctx));
    const end = ctx.messages.at(-1)!;
    if (end.role === "toolResult") { results.push(toolResults(ctx)); return reply("收尾"); }
    const input = lastUser(ctx);
    if (input.startsWith("[子 agent") || input.startsWith("随便")) return onWake(input, ctx, signal);
    if (input.endsWith("派")) return call(["subagent", { action: "spawn", name: "w", task: "查天气" }]);
    if (input.endsWith("追问")) return call(["subagent", { action: "message", name: "w", task: "再查" }]);
    return reply("好");
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await Promise.resolve().then(check).catch(() => false)) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const target = (text: string) => call(["send_message", { text, target: "qq:group:8" }]);
const denied = (results: string[][]) => results.some(rs => rs.some(t => t.includes("基础权限")));

describe("唤醒回合继承派出者（pi）", () => {
  it("owner 派出 → 唤醒回合为 owner：可 target，技能与授权可用（群里只读本群）", async () => {
    const results: string[][] = [], seen: { identity: unknown; bound: PiCallBinding | undefined }[] = [];
    let r!: ResidentRig;
    r = await residentRig({ owners: OWNERS, brain: script(async () => {
      seen.push({ identity: r.host.currentIdentity("group:7"), bound: await r.pi.binding(Number((await conversation(r)).id)) });
      return target("转告");
    }, results) });
    await r.say("1", "派");
    await waitFor(() => results.length >= 2);
    await r.idle();
    expect(r.texts("8")).toEqual(["转告"]);
    expect(seen[0]!.identity).toEqual({ kind: "wake", inherited: owner1 });
    expect(seen[0]!.bound).toMatchObject({ identity: { kind: "wake", inherited: owner1 }, access: "group:7", senderIsOwner: true, auth: true, inputs: [] });
    expect((await r.pi.harness.snapshot(SubagentDoc, (await conversation(r)).id, context))!.children.w!.spawner)
      .toEqual({ turn: "user", as: owner1 });
  });

  it("成员 B 派出 → 唤醒回合为 B：有 send 授权才能 target", async () => {
    const results: string[][] = [];
    const r = await residentRig({ owners: OWNERS, brain: script(() => target("转告"), results) });
    await r.grants.panel("auth_grant", SEND_GRANT);
    await r.say("5", "派");
    await waitFor(() => results.length >= 2);
    await r.idle();
    expect(r.texts("8")).toEqual(["转告"]);
    expect(denied(results)).toBe(false);
  });

  it("同一唤醒 run 混入另一人派出的汇报 → 回落到基础权限", async () => {
    const results: string[][] = [], hold = gate();
    const r = await residentRig({ owners: OWNERS, brain: script(async (input, _ctx, signal) => {
      if (input.includes("混入")) return target("第二次");
      await hold.wait(signal);
      return target("第一次");
    }, results) });
    await r.grants.panel("auth_grant", SEND_GRANT);
    await r.grants.panel("auth_grant", { user: "qq:6", caps: ["send"], targets: ["qq:group:8"] });
    await r.say("5", "派");
    await waitFor(() => hold.entered === 1 && r.host.currentIdentity("group:7")?.kind === "wake");
    expect(r.host.currentIdentity("group:7")).toEqual({ kind: "wake", inherited: member5 });
    // 6 派出的子 agent 的汇报以插话并入同一个唤醒 run
    const data: SubagentReportData = { name: "x", status: "done", child: 999, anchor: 1, reporter: 1,
      spawner: { turn: "user", as: { kind: "user", person: "6", owner: false } } };
    await (await conversation(r)).submit({ type: "input", whenBusy: "steer", requestId: SUBAGENT_REPORT_REQUEST_PREFIX + "999:e1",
      content: "[子 agent 完成] x：混入", entry: { kind: SUBAGENT_REPORT_KIND, data } }, context);
    hold.open();
    await waitFor(() => denied(results));
    await r.idle();
    expect(r.texts("8")).toEqual(["第一次"]);
    expect(denied(results)).toBe(true);
  });

  it("没有派出记录的汇报、不是汇报的后端 run → 基础权限（owner 会话也一样）", async () => {
    const results: string[][] = [];
    let r!: ResidentRig;
    const bound: (PiCallBinding | undefined)[] = [];
    r = await residentRig({ owners: OWNERS, brain: script(async () => {
      bound.push(await r.pi.binding(Number((await conversation(r)).id)));
      return target("越权");
    }, results) });
    await r.say("1", "你好");
    await r.idle();
    const conv = await conversation(r);
    // 升级前派出的子 agent：汇报没有 spawner
    const legacy: SubagentReportData = { name: "旧", status: "done", child: 998, anchor: 1, reporter: 1 };
    await conv.submit({ type: "input", requestId: SUBAGENT_REPORT_REQUEST_PREFIX + "998:e1", content: "[子 agent 完成] 旧：结果",
      entry: { kind: SUBAGENT_REPORT_KIND, data: legacy } }, context);
    await waitFor(() => results.length >= 1);
    await r.idle();
    await conv.submit({ type: "input", requestId: "other-1", content: "随便" }, context);
    await waitFor(() => results.length >= 2);
    await r.idle();
    expect(r.texts("8")).toEqual([]);
    // 基础权限的唤醒回合只配基础工具集（没有 target 参数），越权调用在参数校验或权限复核处被拒；以实际未发出为准
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(bound.length).toBeGreaterThanOrEqual(2);
    // 读取范围、参考图、技能与授权都只是基础权限
    for (const b of bound) expect(b).toMatchObject({ identity: { kind: "wake" }, access: "group:7", senderIsOwner: false, auth: false, inputs: [] });
    expect(bound.every(b => !("inherited" in b!.identity))).toBe(true);
  });

  it("唤醒回合派出的子 agent：再次唤醒沿链继承", async () => {
    const results: string[][] = [];
    const r = await residentRig({ owners: OWNERS, brain: script(input =>
      input.includes("w2：") ? target("链") : call(["subagent", { action: "spawn", name: "w2", task: "再查" }]), results) });
    await r.grants.panel("auth_grant", SEND_GRANT);
    await r.say("5", "派");
    await waitFor(() => r.texts("8").length >= 1 || results.length >= 4);
    await r.idle();
    expect(r.texts("8")).toEqual(["链"]);
    const children = (await r.pi.harness.snapshot(SubagentDoc, (await conversation(r)).id, context))!.children;
    expect(children.w!.spawner).toEqual({ turn: "user", as: member5 });
    expect(children.w2!.spawner).toEqual({ turn: "wake", as: member5 });
  });

  it("另一人 message 同一个子 agent：登记的身份合并为基础权限，之后的汇报唤醒不能 target（两人各自都能 target）", async () => {
    const results: string[][] = [];
    const r = await residentRig({ owners: OWNERS, brain: script(input => input.includes("雨") ? target("越权") : reply("知道了"), results,
      ctx => lastUser(ctx) === "再查" ? "雨" : "晴") });
    await r.grants.panel("auth_grant", SEND_GRANT);
    await r.say("1", "派");
    await waitFor(async () => (await r.pi.harness.snapshot(SubagentDoc, (await conversation(r)).id, context))?.children.w?.last !== undefined);
    await r.idle();
    await r.say("5", "追问");
    await waitFor(() => results.length >= 1);
    await r.idle();
    expect(r.texts("8")).toEqual([]);
    expect((await r.pi.harness.snapshot(SubagentDoc, (await conversation(r)).id, context))!.children.w!.spawner).toEqual({ turn: "user" });
  });

  it("重启后唤醒回合保持继承身份", async () => {
    const results: string[][] = [], hold = gate();
    const r = await residentRig({ owners: OWNERS, brain: script(async (_input, _ctx, signal) => { await hold.wait(signal); return target("重启后"); }, results) });
    await r.grants.panel("auth_grant", SEND_GRANT);
    await r.say("5", "派");
    await waitFor(() => hold.entered === 1 && r.host.currentIdentity("group:7")?.kind === "wake");
    await r.restart();
    expect(r.host.currentIdentity("group:7")).toEqual({ kind: "wake", inherited: member5 });
    expect(r.host.thread("group:7")).toMatchObject({ turnKind: "wake", turnInherited: member5 });
    hold.open();
    await waitFor(() => r.texts("8").length >= 1 || denied(results), 20_000);
    await r.idle(20_000);
    expect(r.texts("8")).toEqual(["重启后"]);
  });
});

describe("子 agent 与唤醒工具集按派出者身份（pi）", () => {
  async function childBinding(r: ResidentRig) {
    const record = (await r.pi.harness.snapshot(SubagentDoc, (await conversation(r)).id, context))!.children.w!;
    return r.pi.binding(record.conversation);
  }

  it("子会话继承派出者的读取权限（群里 owner 派出也只读本群）；仍无技能写与授权", async () => {
    const results: string[][] = [];
    const r = await residentRig({ owners: OWNERS, brain: script(() => reply("知道了"), results) });
    await r.say("1", "派");
    await waitFor(async () => (await r.pi.harness.snapshot(SubagentDoc, (await conversation(r)).id, context))?.children.w?.last !== undefined);
    await r.idle();
    expect(await childBinding(r)).toMatchObject({ child: true, identity: { kind: "wake", inherited: owner1 }, access: "group:7", senderIsOwner: false, auth: false });

    const m = await residentRig({ owners: OWNERS, brain: script(() => reply("知道了"), []) });
    await m.say("5", "派");
    await waitFor(async () => (await m.pi.harness.snapshot(SubagentDoc, (await conversation(m)).id, context))?.children.w?.last !== undefined);
    await m.idle();
    expect(await childBinding(m)).toMatchObject({ child: true, identity: { kind: "wake", inherited: member5 }, access: "group:7", auth: false });
  });

  it("另一人 message 后子会话降为基础权限；登记缺失时子会话只有基础权限", async () => {
    const r = await residentRig({ owners: OWNERS, brain: script(() => reply("知道了"), []) });
    await r.say("1", "派");
    await waitFor(async () => (await r.pi.harness.snapshot(SubagentDoc, (await conversation(r)).id, context))?.children.w?.last !== undefined);
    await r.idle();
    await r.say("5", "追问");
    await waitFor(async () => (await r.pi.harness.snapshot(SubagentDoc, (await conversation(r)).id, context))?.children.w?.spawner?.as === undefined);
    await r.idle();
    const bound = await childBinding(r);
    expect(bound).toMatchObject({ child: true, access: "group:7", auth: false });
    expect("inherited" in bound!.identity).toBe(false);
  });

  it("唤醒开始时按继承身份配置工具：owner 派出的子 agent 在成员回合之后汇报，唤醒回合换成 owner 工具集", async () => {
    const childGate = gate(), seen: string[][] = [];
    let r!: ResidentRig;
    const brain: Brain = async (ctx, signal) => {
      if (isChild(ctx)) { await childGate.wait(signal); return reply("晴"); }
      const end = ctx.messages.at(-1)!;
      if (end.role === "toolResult") return reply("收尾");
      const input = lastUser(ctx);
      if (input.startsWith("[子 agent")) {
        await waitFor(() => r.host.currentIdentity("group:7")?.kind === "wake");
        seen.push((await (await conversation(r)).agent(context)).extensions.map(e => e.name));
        return reply("收到");
      }
      if (input.endsWith("派")) return call(["subagent", { action: "spawn", name: "w", task: "查天气" }]);
      seen.push((await (await conversation(r)).agent(context)).extensions.map(e => e.name));
      return reply("好");
    };
    r = await residentRig({ owners: OWNERS, brain });
    await r.say("1", "派");
    await waitFor(() => childGate.entered === 1);
    await r.idle();
    await r.say("5", "随口一问");
    await r.idle();
    childGate.open();
    await waitFor(() => seen.length >= 2);
    await r.idle();
    expect(seen[0]).toContain("cs-pi-im");
    expect(seen[1]).toContain("cs-pi-im-owner");
    expect(seen[1]).not.toContain("cs-pi-im");
  });
});

describe("安全回归（§7.3）", () => {
  it("子 agent 运行中被另一人转向（steer）：原汇报任务的快照也随登记降级，唤醒不继承派出者", async () => {
    const childGate = gate(), wakes: unknown[] = [];
    let r!: ResidentRig;
    const brain: Brain = async (ctx, signal) => {
      if (isChild(ctx)) { await childGate.wait(signal); return reply("结果"); }
      const end = ctx.messages.at(-1)!;
      if (end.role === "toolResult") return reply("收尾");
      const input = lastUser(ctx);
      if (input.startsWith("[子 agent")) {
        await waitFor(() => r.host.currentIdentity("group:7")?.kind === "wake");
        wakes.push(r.host.currentIdentity("group:7"));
        return target("越权");
      }
      if (input.endsWith("派")) return call(["subagent", { action: "spawn", name: "w", task: "查天气" }]);
      if (input.endsWith("插话")) return call(["subagent", { action: "message", name: "w", task: "顺便查别的", mode: "steer" }]);
      return reply("好");
    };
    r = await residentRig({ owners: OWNERS, brain });
    await r.grants.panel("auth_grant", SEND_GRANT);
    await r.grants.panel("auth_grant", { user: "qq:6", caps: ["send"], targets: ["qq:group:8"] });
    await r.say("5", "派");
    await waitFor(() => childGate.entered >= 1);
    await r.idle();
    await r.say("6", "插话");
    await r.idle();
    childGate.open();
    await waitFor(() => wakes.length >= 1);
    await r.idle();
    expect(wakes.every(w => !("inherited" in (w as object)))).toBe(true);
    expect(r.texts("8")).toEqual([]);
  });
});
