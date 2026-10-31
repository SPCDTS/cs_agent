import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse, JobInputSchema, relativePath, type ExecResult } from "./protocol.ts";
import { readJson, atomicJson, restore, snapshot, inside } from "./files.ts";

const inputFile = process.argv[2];
if (!inputFile) throw new Error("input_required");
const job = parse(JobInputSchema, await readJson(inputFile));
const work = "C:\\AgentWork", output = "C:\\AgentOutput", objects = path.join(path.dirname(inputFile), "objects");
await restore(work, job.source, objects);
const relative = relativePath(job.operation.cwd, true), cwd = relative ? inside(work, relative) : work;
const stat = await fs.lstat(cwd); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not_a_directory");
const command = job.operation.kind === "node.test"
  ? "& npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & npm.cmd run " + job.operation.script
  : job.operation.command;
if (job.operation.kind === "shell.exec" && job.operation.shell !== "powershell") throw new Error("unsupported_shell");
const script = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; " + command + "\nexit $LASTEXITCODE";
await fs.mkdir(output, { recursive: true });
const result: ExecResult = await new Promise((resolve, reject) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    cwd, windowsHide: true, env: { ...process.env, PATH: "C:\\AgentTools\\node;C:\\AgentTools\\git\\cmd;" + process.env.PATH,
      npm_config_cache: "C:\\AgentNpm", npm_config_update_notifier: "false", CI: "true" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false;
  const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
    const prior = target === "stdout" ? stdout : stderr, combined = Buffer.concat([prior, chunk]);
    truncated ||= combined.length > 65536;
    if (target === "stdout") stdout = combined.subarray(-65536); else stderr = combined.subarray(-65536);
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  child.once("error", reject);
  // 超时/取消由宿主销毁本任务 WSB，整个进程树随实例终止。此处不把局部 kill 当作完成。
  child.once("close", code => resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), code, timedOut: false, truncated }));
});
const source = await snapshot(work, path.join(output, "objects"));
const original = new Map(job.source.files.map(file => [file.path, file]));
source.files = source.files.map(file => ({ ...file, mode: original.get(file.path)?.mode ?? file.mode, mime: original.get(file.path)?.mime ?? file.mime }));
await atomicJson(path.join(output, "outcome.json"), { kind: "completed", result, snapshot: source });
