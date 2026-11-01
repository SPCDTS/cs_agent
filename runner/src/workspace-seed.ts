import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { parse } from "./protocol.ts";
import { atomicJson, exists, readJson, sha256 } from "./files.ts";

const PlanSchema = Type.Object({ version: Type.Literal(1), source: Type.String(), complete: Type.Boolean(),
  repos: Type.Array(Type.Object({ name: Type.String(), commit: Type.String({ pattern: "^[a-f0-9]{40,64}$" }), done: Type.Boolean() })) });

/** 必须在 guest 内调用；从只读来源做完整独立 clone，不共享 .git、工作树或 node_modules。 */
export async function seedWorkspace(options: { source: string; work: string; sourceId: string; workspace: string; git: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  const work = path.resolve(options.work), source = path.resolve(options.source), marker = path.join(work, ".cs-agent-workspace-seed.json");
  if (work === source) throw new Error("workspace_seed_same_directory");
  const git = (args: string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn(options.git, ["-c", "core.hooksPath=" + path.join(work, ".cs-agent-no-hooks"), "-c", "core.fsmonitor=false", ...args],
      { env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", error = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { out = (out + chunk).slice(-65536); });
    child.stderr.setEncoding("utf8").on("data", chunk => { error = (error + chunk).slice(-2000); });
    child.once("error", reject); child.once("close", code => code === 0 ? resolve(out.trim()) : reject(new Error("workspace_seed_git_failed: " + error)));
  });
  await fs.mkdir(work, { recursive: true });
  let plan;
  if (await exists(marker)) {
    plan = parse(PlanSchema, await readJson(marker));
    if (plan.source !== options.sourceId) throw new Error("workspace_seed_source_changed");
    if (plan.complete) return "";
  } else {
    if ((await fs.readdir(work)).length) return "当前工作区已有文件，保留原内容，不自动覆盖。\n";
    const repos = [];
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".cs-agent-")) continue;
      const repository = path.join(source, entry.name);
      if (!await exists(path.join(repository, ".git"))) continue;
      const commit = await git(["-C", repository, "rev-parse", "--verify", "HEAD^{commit}"]);
      repos.push({ name: entry.name, commit, done: false });
    }
    plan = parse(PlanSchema, { version: 1, source: options.sourceId, complete: false, repos });
    await atomicJson(marker, plan);
  }
  for (const repo of plan.repos) {
    if (repo.name !== path.basename(repo.name) || repo.name === "." || repo.name === "..") throw new Error("workspace_seed_invalid_path");
    if (repo.done) continue;
    const target = path.resolve(work, repo.name), temporary = path.resolve(work, ".cs-agent-seed-" + sha256(repo.name).slice(0, 16));
    if (path.dirname(target) !== work || path.dirname(temporary) !== work) throw new Error("workspace_seed_invalid_path");
    if (await exists(target)) {
      if ((await fs.lstat(target)).isSymbolicLink() || await git(["-C", target, "rev-parse", "HEAD"]) !== repo.commit) throw new Error("workspace_seed_conflict");
    } else {
      if (await exists(temporary)) {
        if ((await fs.lstat(temporary)).isSymbolicLink()) throw new Error("workspace_seed_invalid_path");
        await fs.rm(temporary, { recursive: true });
      }
      const origin = path.join(source, repo.name);
      await git(["clone", "--no-local", "--no-checkout", "--", origin, temporary]);
      await git(["-C", temporary, "checkout", "-b", "agent/" + sha256(options.workspace).slice(0, 16), repo.commit]);
      const url = await git(["-C", origin, "config", "--get", "remote.origin.url"]).catch(() => "");
      // 本机路径不能变成 child 的远程地址；凭据不从宿主传入 guest。
      if (/^(https?:\/\/|ssh:\/\/|git@)/.test(url)) await git(["-C", temporary, "remote", "set-url", "origin", url]);
      else await git(["-C", temporary, "remote", "remove", "origin"]);
      await fs.rename(temporary, target);
    }
    repo.done = true; await atomicJson(marker, plan);
  }
  plan.complete = true; await atomicJson(marker, plan);
  return plan.repos.length ? "已准备独立仓库：" + plan.repos.map(repo => repo.name + "@" + repo.commit.slice(0, 12)).join("，") + "；依赖请在各项目中运行 npm-ensure.mjs，下载缓存已复用。\n"
    : "来源工作区没有可克隆的子目录仓库；当前工作区可自行准备源码。\n";
}
