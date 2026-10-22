import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { grantsFixture } from "../agent/grants-fixture.js";
import { SkillsStore, publishSkill } from "../../src/agent/skills-store.js";
import { SkillsLoader } from "../../src/agent/pi-tools/skills.js";
import { imRig } from "./im-fixture.js";

/** skill_publish 经 codex 的 im MCP 与线程令牌到主进程：只在 owner 本人发起的回合（含继承 owner 的唤醒）放行。 */
async function setup(owner: boolean, mode: "user" | "wake" = "user") {
  const f = await grantsFixture(owner ? "1" : "99");
  const dir = path.join(f.dir, "skills"), skills = new SkillsStore({ dir, loader: new SkillsLoader({ dir }) });
  const binding = { ...f.binding, session: "thr-1", imageDir: path.join(f.dir, "images", "group_7"),
    ...(mode === "wake" ? { identity: { kind: "wake" as const } } : {}) };
  const rig = await imRig(binding.threadKey, {
    resolve: () => binding,
    permissions: b => f.grants.permissions(b),
    send: async () => ({}),
    skillPublish: (b, args) => publishSkill(skills, b.workdir, args),
  });
  await fs.mkdir(path.join(f.workdir, "hello"));
  await fs.writeFile(path.join(f.workdir, "hello", "SKILL.md"), "---\nname: hello\ndescription: 打招呼\n---\n正文");
  return { ...f, ...rig, dir };
}

it("owner 回合发布工作区里的技能目录，返回名称与生效提示", async () => {
  const f = await setup(true);
  const result = await f.tool("skill_publish", { path: "hello" });
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result.content)).toContain("下一条消息起生效");
  expect(await fs.readFile(path.join(f.dir, "hello", "SKILL.md"), "utf8")).toContain("打招呼");
  expect((await f.tool("skill_publish", { path: "hello" })).isError).toBe(true);
  expect((await f.tool("skill_publish", { path: "hello", overwrite: true })).isError).not.toBe(true);
});

it.each([[false, "user"], [true, "wake"]] as const)("非 owner 回合与没有继承身份的唤醒回合在主进程拒绝（owner=%s mode=%s）", async (owner, mode) => {
  const f = await setup(owner, mode);
  const result = await f.tool("skill_publish", { path: "hello" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("仅限 owner 本人");
  expect((await f.post("skill_publish", { path: "hello" })).status).toBe(400);
  await expect(fs.access(path.join(f.dir, "hello"))).rejects.toThrow();
});
