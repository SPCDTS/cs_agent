import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore, memoryHash, normalizeMemoryText } from "../../src/context/memory/store.js";
import { PROFILE_NONE, ProfileStore } from "../../src/context/memory/profile.js";
import type { MemoryInput } from "../../src/context/memory/types.js";
import { tmp } from "../agent/helpers.js";

const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.splice(0)) fn(); });

function rig(start = 1_790_000_000) {
  const dir = tmp("cs-memory-store-");
  let now = start;
  const store = new MemoryStore(dir, () => now);
  clean.push(() => store.close());
  const add = (text: string, extra: Partial<MemoryInput> = {}) => store.remember({ ns: "owner", kind: "fact", text, author: "qq:1", ...extra });
  return { dir, store, add, tick: (s = 1) => { now += s; } };
}

describe("MemoryStore：SQLite 与 FTS", () => {
  it("建库为 WAL，含三张表与 trigram FTS；正文与 subject 的修改同步进 FTS", () => {
    const r = rig();
    const db = new DatabaseSync(r.store.file, { readOnly: true });
    try {
      expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      const names = (db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','trigger')").all() as { name: string }[]).map(x => x.name);
      for (const name of ["memories", "memory_versions", "memory_links", "memories_fts", "memories_ai", "memories_ad", "memories_au"]) expect(names).toContain(name);
    } finally { db.close(); }
    const { row } = r.add("住在上海浦东，工作日通勤约 50 分钟", { subject: "self" });
    expect(r.store.search({ scope: ["owner"], query: "上海浦东", limit: 10 }).map(x => x.id)).toEqual([row.id]);
    // 两字词与 subject 也能命中；多个词须全部命中
    expect(r.store.search({ scope: "all", query: "通勤", limit: 10 })).toHaveLength(1);
    expect(r.store.search({ scope: "all", query: "self", limit: 10 })).toHaveLength(1);
    expect(r.store.search({ scope: "all", query: "浦东 杭州", limit: 10 })).toHaveLength(0);
    r.store.update(row.id, { text: "住在杭州西湖区" }, "qq:1");
    expect(r.store.search({ scope: "all", query: "浦东", limit: 10 })).toHaveLength(0);
    expect(r.store.search({ scope: "all", query: "西湖", limit: 10 })).toHaveLength(1);
  });

  it("检索与列表按命名空间范围过滤；缺省只看 active；列表 commitment 按截止排序、无截止的在后", () => {
    const r = rig();
    const own = r.add("喜欢喝美式咖啡", { kind: "preference" }).row;
    r.tick();
    const group = r.add("群里周五聚餐喝咖啡", { ns: "group:7" }).row;
    expect(r.store.search({ scope: ["group:7"], query: "咖啡", limit: 10 }).map(x => x.id)).toEqual([group.id]);
    expect(r.store.search({ scope: ["owner", "group:7"], query: "咖啡", limit: 10 }).map(x => x.id)).toEqual([group.id, own.id]);
    expect(r.store.search({ scope: [], query: "咖啡", limit: 10 })).toEqual([]);
    r.store.setStatus(group.id, "forgotten", "qq:1", "测试");
    expect(r.store.search({ scope: "all", query: "咖啡", limit: 10 }).map(x => x.id)).toEqual([own.id]);
    expect(r.store.search({ scope: "all", query: "咖啡", status: "forgotten", limit: 10 }).map(x => x.id)).toEqual([group.id]);
    // 最近召回优先
    r.tick();
    const other = r.add("咖啡要少糖", { kind: "preference" }).row;
    r.tick();
    r.store.touchRecall([own.id]);
    expect(r.store.search({ scope: ["owner"], query: "咖啡", limit: 10 }).map(x => x.id)).toEqual([own.id, other.id]);
    expect(r.store.get(own.id)).toMatchObject({ recall_count: 1 });
    const late = r.add("月底交报告", { kind: "commitment", due_at: 2_000_000_000 }).row;
    const none = r.add("有空整理相册", { kind: "commitment" }).row;
    const soon = r.add("周四前发周报模板", { kind: "commitment", due_at: 1_800_000_000 }).row;
    expect(r.store.list({ scope: ["owner"], kind: "commitment", limit: 10 }).map(x => x.id)).toEqual([soon.id, late.id, none.id]);
    expect(r.store.list({ scope: ["owner"], limit: 2 }).map(x => x.id)).toEqual([soon.id, none.id]);
    r.store.update(soon.id, { done_at: 1_790_000_100 }, "qq:1");
    expect(r.store.openCommitments("owner").map(x => x.id)).toEqual([late.id, none.id]);
  });
});

describe("MemoryStore：去重、取代与版本", () => {
  it("规整后正文相同的 active 条目不重复写；命名空间或种类不同则是不同条目", () => {
    const r = rig();
    const first = r.add("养了一只猫叫团子。");
    expect(first.duplicate).toBe(false);
    const again = r.add("  养了一只猫叫团子 ");
    expect(again).toMatchObject({ duplicate: true, row: { id: first.row.id } });
    expect(normalizeMemoryText("Hello  World。")).toBe("hello world");
    expect(memoryHash("owner", "fact", "A")).not.toBe(memoryHash("group:7", "fact", "A"));
    expect(r.add("养了一只猫叫团子", { ns: "group:7" }).duplicate).toBe(false);
    expect(r.add("养了一只猫叫团子", { kind: "episode" }).duplicate).toBe(false);
    // 遗忘后再记一次是新条目
    r.store.setStatus(first.row.id, "forgotten", "qq:1");
    expect(r.add("养了一只猫叫团子").duplicate).toBe(false);
  });

  it("supersedes 同事务取代旧条目并建链；跨命名空间与非 active 的旧条目拒绝且不留下半成品", () => {
    const r = rig();
    const old = r.add("住在上海").row;
    r.tick(10);
    const next = r.store.remember({ ns: "owner", kind: "fact", text: "搬到杭州了", author: "qq:1" }, { supersedes: old.id });
    expect(next.superseded).toMatchObject({ id: old.id, status: "superseded", until: 1_790_000_010 });
    expect(r.store.links(old.id)).toEqual([{ from_id: next.row.id, to_id: old.id, rel: "supersedes", created_at: 1_790_000_010 }]);
    expect(r.store.versions(old.id).map(v => v.reason)).toEqual(["remember", "superseded"]);
    const before = r.store.browse({ limit: 50 }).total;
    expect(() => r.store.remember({ ns: "owner", kind: "fact", text: "又搬家", author: "qq:1" }, { supersedes: old.id })).toThrow(/不是 active/);
    const g = r.add("群公告", { ns: "group:7" }).row;
    expect(() => r.store.remember({ ns: "owner", kind: "fact", text: "跨域取代", author: "qq:1" }, { supersedes: g.id })).toThrow(/同一命名空间/);
    expect(r.store.browse({ limit: 50 }).total).toBe(before + 1);
  });

  it("新正文已有相同的 active 条目时，supersedes 仍在同事务取代旧条目并建链；until 覆盖为取代时间", () => {
    const r = rig();
    const a = r.add("住上海", { until: 2_000_000_000 }).row;
    const b = r.add("住杭州").row;
    r.tick(5);
    const result = r.store.remember({ ns: "owner", kind: "fact", text: "住杭州。", author: "qq:1" }, { supersedes: a.id });
    expect(result).toMatchObject({ duplicate: true, row: { id: b.id }, superseded: { id: a.id, status: "superseded", until: 1_790_000_005 } });
    expect(r.store.links(a.id)).toEqual([expect.objectContaining({ from_id: b.id, to_id: a.id, rel: "supersedes" })]);
    // 拿重复条目自己当 supersedes 不会把自己标掉
    expect(r.store.remember({ ns: "owner", kind: "fact", text: "住杭州", author: "qq:1" }, { supersedes: b.id })).toMatchObject({ duplicate: true });
    expect(r.store.get(b.id)?.status).toBe("active");
  });

  it("检索词里的 %、_、\\ 按字面匹配，不当通配符", () => {
    const r = rig();
    const lit = r.add("配置项 foo_bar 要开").row;
    r.add("配置项 fooXbar 不用管");
    r.add("配置项 foobar 也不是");
    const pct = r.add("折扣 50% 起").row;
    r.add("折扣 500 元");
    const slash = r.add("路径 C:\\work\\a").row;
    const ids = (query: string) => r.store.search({ scope: "all", query, limit: 10 }).map(x => x.id);
    expect(ids("foo_bar")).toEqual([lit.id]);
    expect(ids("50%")).toEqual([pct.id]);
    expect(ids("\\work")).toEqual([slash.id]);
    expect(r.store.browse({ query: "foo_bar", limit: 10 }).items.map(x => x.id)).toEqual([lit.id]);
    expect(ids("foobar")).toHaveLength(1);
  });

  it("每次状态或正文变化写一行版本；遗忘可按版本找回之前的状态", () => {
    const r = rig();
    const row = r.add("周报每周五发").row;
    r.store.update(row.id, { text: "周报每周四发" }, "qq:1", "改日子");
    r.store.setStatus(row.id, "superseded", "consolidate:b1");
    r.store.setStatus(row.id, "forgotten", "dashboard", "不再需要");
    const versions = r.store.versions(row.id);
    expect(versions.map(v => [v.by, v.reason])).toEqual([["qq:1", "remember"], ["qq:1", "改日子"], ["consolidate:b1", "superseded"], ["dashboard", "不再需要"]]);
    expect(JSON.parse(versions[1]!.before_json!).text).toBe("周报每周五发");
    expect(JSON.parse(versions[1]!.after_json).text).toBe("周报每周四发");
    expect(r.store.statusBeforeForget(row.id)).toBe("superseded");
    expect(r.store.update(row.id, { subject: "周报" }, "qq:1").hash).toBe(memoryHash("owner", "fact", "周报每周四发"));
    expect(() => r.store.update(row.id, {}, "qq:1")).toThrow(/没有要修改/);
  });

  it("面板浏览：全部状态、按命名空间与关键词筛选并给出总数", () => {
    const r = rig();
    for (let i = 0; i < 3; i++) r.add(`第 ${i} 条笔记`, { ns: i ? "owner" : "private:5" });
    r.store.setStatus(1, "forgotten", "dashboard");
    expect(r.store.browse({ limit: 2 })).toMatchObject({ total: 3 });
    expect(r.store.browse({ limit: 2 }).items).toHaveLength(2);
    expect(r.store.browse({ ns: "owner", limit: 10 }).total).toBe(2);
    expect(r.store.browse({ status: "forgotten", limit: 10 }).items.map(x => x.id)).toEqual([1]);
    expect(r.store.browse({ query: "第 2", limit: 10 }).total).toBe(1);
    expect(r.store.namespaces()).toEqual(["owner", "private:5"]);
  });
});

describe("ProfileStore：画像读写", () => {
  it("不存在时为空、revision 为 none；CAS 写入，旧 revision 拒绝；路径中的冒号换下划线", async () => {
    const dir = tmp("cs-memory-profile-"), profiles = new ProfileStore(dir);
    expect(await profiles.read("group:7")).toMatchObject({ text: "", revision: PROFILE_NONE });
    expect(profiles.file("group:7")).toBe(path.join(dir, "memory", "group_7", "profile.md"));
    await expect(profiles.write("owner", "称呼：老王", "stale")).rejects.toMatchObject({ code: "stale" });
    const { revision } = await profiles.write("owner", "称呼：老王\r\n职业：工程师", PROFILE_NONE);
    expect(await fs.readFile(profiles.file("owner"), "utf8")).toBe("称呼：老王\n职业：工程师");
    const read = await profiles.read("owner");
    expect(read).toMatchObject({ text: "称呼：老王\n职业：工程师", revision });
    await expect(profiles.write("owner", "改写", PROFILE_NONE)).rejects.toMatchObject({ code: "stale" });
    const next = await profiles.write("owner", "改写", revision);
    expect(next.revision).not.toBe(revision);
    // 同一命名空间的并发写入串行，第二个拿着过期 revision 被拒
    const results = await Promise.allSettled([profiles.write("owner", "A", next.revision), profiles.write("owner", "B", next.revision)]);
    expect(results.map(x => x.status)).toEqual(["fulfilled", "rejected"]);
  });

  it("命名空间目录或画像根目录是链接（Windows 为 junction）时拒绝读取，不会读到别的命名空间的画像", async () => {
    const dir = tmp("cs-memory-profile-"), profiles = new ProfileStore(dir);
    await profiles.write("owner", "称呼：老王", PROFILE_NONE);
    await fs.symlink(path.join(dir, "memory", "owner"), path.join(dir, "memory", "group_7"), process.platform === "win32" ? "junction" : "dir");
    await expect(profiles.read("group:7")).rejects.toThrow(/链接/);
    // 根目录本身是链接也拒绝
    const other = tmp("cs-memory-profile-"), linked = new ProfileStore(other);
    await fs.symlink(path.join(dir, "memory"), path.join(other, "memory"), process.platform === "win32" ? "junction" : "dir");
    await expect(linked.read("owner")).rejects.toThrow(/链接/);
    // 画像文件本身是链接
    await fs.mkdir(path.join(dir, "memory", "private_5"));
    try {
      await fs.symlink(profiles.file("owner"), profiles.file("private:5"), "file");
      await expect(profiles.read("private:5")).rejects.toThrow(/普通文件/);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; /* Windows 无权限建文件链接时跳过 */ }
  });

  it("超过 4 KiB、含凭据样式内容、非法命名空间一律拒绝", async () => {
    const profiles = new ProfileStore(tmp("cs-memory-profile-"));
    await expect(profiles.write("owner", "字".repeat(1400), PROFILE_NONE)).rejects.toThrow(/4 KiB/);
    await expect(profiles.write("owner", "api_key=sk-abcdefghijklmnop", PROFILE_NONE)).rejects.toMatchObject({ code: "secret" });
    await expect(profiles.write("../x", "hi", PROFILE_NONE)).rejects.toThrow(/命名空间/);
    expect(() => profiles.file("group:../7")).toThrow();
  });
});
