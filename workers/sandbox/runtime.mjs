// 原生 Container.exec 调用的固定本地助手；不监听端口，也不接收宿主命令。
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { relativePath, setTreeOwner, workspaceControl } from "./workspace.mjs";

export const OUTPUT_CAP = 64 * 1024;
const MAX_TIMEOUT_MS = 120000;
const SKILL_OUT_MAX_FILES = 5;
const SKILL_OUT_MAX_BYTES = 8 * 1024 * 1024;
export const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};
function fail(code) { throw new Error(code); }
async function realpathLoose(file, depth = 0) {
  if (depth > 40) fail("path_denied");
  try { return await fs.realpath(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return; throw error; });
  if (stat?.isSymbolicLink()) return realpathLoose(path.resolve(path.dirname(file), await fs.readlink(file)), depth + 1);
  const parent = path.dirname(file);
  if (parent === file) fail("path_denied");
  return path.join(await realpathLoose(parent, depth + 1), path.basename(file));
}
export async function resolveInside(root, raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) fail("invalid_request");
  const absolute = path.resolve(root, raw);
  if (!within(root, absolute)) fail("path_denied");
  const real = await realpathLoose(absolute);
  if (!within(await fs.realpath(root), real)) fail("path_denied");
  return real;
}
export function tailCollector(cap = OUTPUT_CAP) {
  const chunks = [];
  let kept = 0, dropped = 0;
  return {
    push(chunk) {
      chunks.push(chunk); kept += chunk.length;
      while (chunks.length > 1 && kept - chunks[0].length >= cap) { const first = chunks.shift(); kept -= first.length; dropped += first.length; }
    },
    result() {
      let bytes = Buffer.concat(chunks), skipped = dropped;
      if (bytes.length > cap) { skipped += bytes.length - cap; bytes = bytes.subarray(bytes.length - cap); }
      let start = 0;
      if (skipped) while (start < bytes.length && start < 3 && (bytes[start] & 0xc0) === 0x80) start++;
      return { text: skipped ? `[前 ${skipped + start} 字节已省略]\n${bytes.subarray(start).toString("utf8")}` : bytes.toString("utf8"), truncated: skipped > 0 };
    },
  };
}
async function setTreeReadOnly(dir) {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  async function walk(target) {
    const entries = await fs.readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        await fs.chmod(full, 0o555);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        await fs.chmod(full, (stat.mode & 0o111) ? 0o555 : 0o444);
      }
      if (isRoot) await fs.chown(full, 0, 0);
    }
  }
  await walk(dir);
  await fs.chmod(dir, 0o555);
  if (isRoot) await fs.chown(dir, 0, 0);
}
async function removeTree(dir) {
  const exists = await fs.lstat(dir).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!exists) return;
  async function makeWritable(target) {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      await fs.chmod(target, 0o755);
      for (const entry of await fs.readdir(target)) await makeWritable(path.join(target, entry));
    } else {
      await fs.chmod(target, 0o644);
    }
  }
  await makeWritable(dir);
  await fs.rm(dir, { recursive: true, force: true });
}
async function replaceTree(stage, destination) {
  await removeTree(destination);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(stage, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fs.cp(stage, destination, { recursive: true, verbatimSymlinks: true });
    await removeTree(stage);
  }
  await setTreeReadOnly(destination);
}
export function createSandboxRuntime({
  root,
  shell = "/bin/bash",
  user,
  env = {},
  skillCodeRoot = "/opt/skill",
  skillDepsRoot = "/opt/skill-deps",
  cacheRoot = "/tmp/skill-cache",
}) {
  const commandEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "dumb", HOME: "/home/sandbox", USER: "sandbox", ...env };
  const own = async file => { if (user) await fs.chown(file, user.uid, user.gid); };
  const workspace = workspaceControl({ root, own });
  const stateRoot = path.join(root, "state");
  const outRoot = path.join(root, "out");
  const stateWorkspace = workspaceControl({ root: stateRoot, own });

  function runProcess({ command, args, cwd, processEnv, timeoutMs, stdinText, shellMode = false }) {
    return new Promise((resolve, reject) => {
      const stdio = stdinText === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
      const child = shellMode
        ? spawn(shell, ["-c", command], { cwd, env: processEnv, detached: process.platform !== "win32", stdio, ...(user ? { uid: user.uid, gid: user.gid } : {}) })
        : spawn(command, args, { cwd, env: processEnv, shell: false, detached: process.platform !== "win32", stdio, ...(user ? { uid: user.uid, gid: user.gid } : {}) });
      const stdout = tailCollector(), stderr = tailCollector();
      let timedOut = false, settled = false;
      // Linux 上整个进程组一起终止，后台进程不能在快照后继续修改工作区。
      const kill = () => {
        try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      const timer = setTimeout(() => { timedOut = true; try { kill(); } catch (error) { reject(error); } }, timeoutMs);
      const finish = code => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { kill(); } catch (error) { reject(error); return; }
        const out = stdout.result(), err = stderr.result();
        resolve({ stdout: out.text, stderr: err.text, code: timedOut ? null : code, timedOut, truncated: out.truncated || err.truncated });
      };
      if (child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(stdinText);
      }
      child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
      child.once("error", error => { stderr.push(Buffer.from(error.message)); finish(127); });
      child.once("close", finish);
      child.once("exit", () => {
        try { kill(); } catch (error) { reject(error); }
        setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(child.exitCode); }, 1000).unref();
      });
    });
  }

  async function exec({ command, cwd, timeoutMs = 60000 }) {
    if (typeof command !== "string" || !command.trim() || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail("invalid_request");
    const directory = await resolveInside(root, cwd ?? root);
    if (!(await fs.stat(directory)).isDirectory()) fail("not_a_directory");
    return runProcess({ command, cwd: directory, processEnv: commandEnv, timeoutMs, shellMode: true });
  }

  async function prepareSkillDirs() {
    for (const dir of [stateRoot, path.join(stateRoot, "home"), path.join(stateRoot, ".config"), path.join(stateRoot, ".local"), path.join(stateRoot, ".local", "share")]) {
      await fs.mkdir(dir, { recursive: true });
      await own(dir);
    }
    await fs.rm(outRoot, { recursive: true, force: true });
    await fs.mkdir(outRoot, { recursive: true });
    await own(outRoot);
    await fs.rm(cacheRoot, { recursive: true, force: true });
    await fs.mkdir(cacheRoot, { recursive: true });
    await own(cacheRoot);
    const depsModules = path.join(skillDepsRoot, "node_modules");
    const hasDeps = await fs.stat(depsModules).then(s => s.isDirectory()).catch(() => false);
    return {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      TERM: "dumb",
      USER: "sandbox",
      HOME: path.join(stateRoot, "home"),
      XDG_CONFIG_HOME: path.join(stateRoot, ".config"),
      XDG_DATA_HOME: path.join(stateRoot, ".local", "share"),
      XDG_CACHE_HOME: cacheRoot,
      SKILL_STATE_DIR: stateRoot,
      SKILL_OUT_DIR: outRoot,
      SKILL_DIR: skillCodeRoot,
      PYTHONNOUSERSITE: "1",
      ...(hasDeps ? { NODE_PATH: depsModules } : {}),
      ...env,
    };
  }

  async function scanSkillOut() {
    const outputs = [];
    let totalBytes = 0;
    async function walk(dir, prefix = "") {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix + entry.name;
        const full = path.join(dir, entry.name);
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail("path_denied");
        relativePath(relative);
        if (stat.isDirectory()) { await walk(full, relative + "/"); continue; }
        if (outputs.length >= SKILL_OUT_MAX_FILES) fail("output_limit");
        totalBytes += stat.size;
        if (stat.size > SKILL_OUT_MAX_BYTES || totalBytes > SKILL_OUT_MAX_BYTES) fail("output_limit");
        const bytes = await fs.readFile(full);
        outputs.push({ path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
    await walk(outRoot);
    return outputs;
  }

  async function materializeSkill({ files, revision, installNpmDeps = false, depsHash = "" }) {
    if (!files || typeof files !== "object" || typeof revision !== "string" || !revision) fail("invalid_request");
    if (installNpmDeps) {
      const currentDeps = await fs.readFile(path.join(skillDepsRoot, ".cs-deps-revision"), "utf8").catch(() => "");
      if (currentDeps !== depsHash) {
        if (typeof files["package.json"] !== "string" || typeof files["package-lock.json"] !== "string") fail("invalid_request");
        const depsParent = path.dirname(skillDepsRoot);
        await fs.mkdir(depsParent, { recursive: true });
        const stage = await fs.mkdtemp(path.join(depsParent, ".cs-deps-stage-"));
        const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), "cs-npm-cache-"));
        try {
          await fs.writeFile(path.join(stage, "package.json"), files["package.json"]);
          await fs.writeFile(path.join(stage, "package-lock.json"), files["package-lock.json"]);
          await fs.chmod(stage, 0o755);
          await setTreeOwner(stage, own);
          await fs.chmod(npmCache, 0o755);
          await setTreeOwner(npmCache, own);
          const npmEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: npmCache, npm_config_cache: npmCache, ...env };
          const installed = await runProcess({
            command: "npm",
            args: ["ci", "--no-audit", "--no-fund", "--ignore-scripts"],
            cwd: stage,
            processEnv: npmEnv,
            timeoutMs: 90_000,
          });
          if (installed.timedOut || installed.code !== 0) fail("skill_deps_install_failed");
          await fs.writeFile(path.join(stage, ".cs-deps-revision"), depsHash, { mode: 0o444 });
          await replaceTree(stage, skillDepsRoot);
        } catch (error) {
          await removeTree(stage).catch(() => {});
          throw error;
        } finally {
          await removeTree(npmCache).catch(() => {});
        }
      }
    }
    const currentRev = await fs.readFile(path.join(skillCodeRoot, ".cs-skill-revision"), "utf8").catch(() => "");
    const hasLinkedModules = !installNpmDeps
      || Object.keys(files).some(key => key === "node_modules" || key.startsWith("node_modules/"))
      || await fs.lstat(path.join(skillCodeRoot, "node_modules")).then(() => true, () => false);
    if (currentRev !== revision || !hasLinkedModules) {
      const codeParent = path.dirname(skillCodeRoot);
      await fs.mkdir(codeParent, { recursive: true });
      const stage = await fs.mkdtemp(path.join(codeParent, ".cs-skill-stage-"));
      try {
        for (const [rawPath, text] of Object.entries(files)) {
          const rel = relativePath(rawPath);
          if (typeof text !== "string") fail("invalid_request");
          const target = path.join(stage, rel);
          await fs.mkdir(path.dirname(target), { recursive: true });
          const executable = rel.endsWith(".sh") || text.startsWith("#!");
          await fs.writeFile(target, text, { mode: executable ? 0o555 : 0o444 });
        }
        if (installNpmDeps && !Object.keys(files).some(key => key === "node_modules" || key.startsWith("node_modules/"))) {
          await fs.symlink(path.join(skillDepsRoot, "node_modules"), path.join(stage, "node_modules"));
        }
        await fs.writeFile(path.join(stage, ".cs-skill-revision"), revision, { mode: 0o444 });
        await replaceTree(stage, skillCodeRoot);
      } catch (error) {
        await removeTree(stage).catch(() => {});
        throw error;
      }
    }
    return { ready: true };
  }

  async function execSkillBash({ command, timeoutMs = 60000 }) {
    if (typeof command !== "string" || !command.trim() || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail("invalid_request");
    const skillEnv = await prepareSkillDirs();
    const res = await runProcess({ command, cwd: skillCodeRoot, processEnv: skillEnv, timeoutMs, shellMode: true });
    const outputs = !res.timedOut && res.code !== null ? await scanSkillOut() : [];
    return { ...res, outputs };
  }

  async function skillStateSnapshot() {
    await fs.mkdir(stateRoot, { recursive: true });
    await own(stateRoot);
    return stateWorkspace.scan([]);
  }

  async function skillStateRestore({ stage, snapshot }) {
    if (typeof stage !== "string" || !/^\/tmp\/sandbox-import-[a-f0-9-]{36}$/.test(stage)) fail("path_denied");
    if ((await fs.realpath(stage)) !== stage) fail("path_denied");
    await fs.mkdir(stateRoot, { recursive: true });
    await own(stateRoot);
    const { id } = await stateWorkspace.start(snapshot);
    for (const file of snapshot.files) {
      const source = await resolveInside(stage, file.path);
      await stateWorkspace.put(id, file.path, await fs.readFile(source));
    }
    return stateWorkspace.commit(id);
  }

  async function clearSkillOut() {
    await fs.rm(outRoot, { recursive: true, force: true });
    await fs.mkdir(outRoot, { recursive: true });
    await own(outRoot);
    return { cleared: true };
  }

  async function restore({ stage, snapshot, reuse = [] }) {
    // stage 由 Worker 随机生成；不允许把其它容器目录作为恢复输入或清理目标。
    if (typeof stage !== "string" || !/^\/tmp\/sandbox-import-[a-f0-9-]{36}$/.test(stage)) fail("path_denied");
    if ((await fs.realpath(stage)) !== stage) fail("path_denied");
    const { id } = await workspace.start(snapshot);
    const local = new Set(reuse);
    for (const file of snapshot.files) {
      const source = await resolveInside(local.has(file.path) ? root : stage, file.path);
      await workspace.put(id, file.path, await fs.readFile(source));
    }
    return workspace.commit(id);
  }
  // 从已校验的清单构建独立目录，容器缓存和后台进程的后续写入不会进入归档。
  async function stageBackup(snapshot) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cs-backup-"));
    const target = path.join(parent, "work");
    try {
      await fs.mkdir(target);
      for (const dir of snapshot.directories) {
        const item = path.join(target, relativePath(dir));
        await fs.mkdir(item, { recursive: true });
      }
      for (const file of snapshot.files) {
        const bytes = await fs.readFile(await resolveInside(root, file.path));
        if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) fail("workspace_conflict");
        const item = path.join(target, relativePath(file.path));
        await fs.mkdir(path.dirname(item), { recursive: true });
        await fs.writeFile(item, bytes, { flag: "wx", mode: file.mode });
        await fs.chmod(item, file.mode);
      }
      await setTreeOwner(target, own);
      return target;
    } catch (error) { await fs.rm(parent, { recursive: true, force: true }); throw error; }
  }
  async function discardBackup(stage) {
    if (typeof stage !== "string" || path.dirname(path.dirname(stage)) !== os.tmpdir() ||
      !/^cs-backup-[a-zA-Z0-9]+$/.test(path.basename(path.dirname(stage))) || path.basename(stage) !== "work") fail("path_denied");
    await fs.rm(path.dirname(stage), { recursive: true, force: true });
    return { restored: true };
  }
  return {
    stageBackup, discardBackup, resolve: raw => resolveInside(root, raw), exec,
    snapshot: retainedPaths => workspace.scan(retainedPaths), restore,
    materializeSkill, execSkillBash, skillStateSnapshot, skillStateRestore, clearSkillOut,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = createSandboxRuntime({ root: "/work", user: { uid: 1000, gid: 1000 } });
  try {
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const action = process.argv[2];
    let result;
    switch (action) {
      case "resolve": result = await runtime.resolve(input.path); break;
      case "exec": result = await runtime.exec(input); break;
      case "snapshot": result = await runtime.snapshot(input.retainedPaths); break;
      case "stageBackup": result = await runtime.stageBackup(input.snapshot); break;
      case "discardBackup": result = await runtime.discardBackup(input.stage); break;
      case "restore": result = await runtime.restore(input); break;
      case "materializeSkill": result = await runtime.materializeSkill(input); break;
      case "execSkillBash": result = await runtime.execSkillBash(input); break;
      case "skillStateSnapshot": result = await runtime.skillStateSnapshot(); break;
      case "skillStateRestore": result = await runtime.skillStateRestore(input); break;
      case "clearSkillOut": result = await runtime.clearSkillOut(); break;
      default: fail("invalid_request");
    }
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const codes = { ENOENT: "not_found", EISDIR: "is_directory", ENOTDIR: "not_a_directory", EACCES: "permission_denied", EPERM: "permission_denied" };
    process.stdout.write(JSON.stringify({ error: codes[error.code] ?? error.message, ...(error.issues ? { issues: error.issues } : {}) }));
    process.exitCode = 1;
  }
}
