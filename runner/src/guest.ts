import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse, JobInputSchema, PowerShellInputSchema, MAX_CONTROL_BYTES, type ExecResult } from "./protocol.ts";
import { readJson } from "./files.ts";
import { prepareResourceFiles } from "./resource-files.ts";

const inputFile = process.argv[2];
if (!inputFile) throw new Error("input_required");
const job = parse(JobInputSchema, await readJson(inputFile));
if (job.tool !== "powershell") throw new Error("tool_not_registered");
const input = parse(PowerShellInputSchema, job.arguments);
const work = "C:\\AgentWork";
const gitConfig = "C:\\Windows\\Temp\\cs-agent-gitconfig";
const guestEnv = { ...process.env, PATH: "C:\\AgentTools\\node;C:\\AgentTools\\git\\cmd;" + process.env.PATH,
  GIT_CONFIG_SYSTEM: gitConfig,
  npm_config_cache: "C:\\AgentCache\\npm", npm_config_update_notifier: "false", CI: "true" };
async function execute(): Promise<ExecResult> {
  await fs.mkdir(work, { recursive: true });
  // 映射目录保留宿主所有者；信任范围仅限 guest 的项目目录。
  await fs.writeFile(gitConfig, "[safe]\n" + ["C:/AgentWork", "C:/AgentWork/*", "C:/AgentSource", "C:/AgentSource/*"].map(directory => "\tdirectory = " + directory + "\n").join(""), "utf8");
  const cwd = path.resolve(work, input.cwd ?? ".");
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error("not_a_directory");
  const script = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; " + input.command + "\nexit $LASTEXITCODE";
  const result: ExecResult = await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      cwd, windowsHide: true, env: guestEnv, stdio: ["ignore", "pipe", "pipe"],
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
    // 超时、取消或连接丢失由宿主销毁整个 VM；普通完成保留此租约的工作目录。
    child.once("close", code => resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), code, timedOut: false, truncated }));
  });
  return result;
}
async function prepare(): Promise<ExecResult> {
  const directive = job.lease.resourcePreparation;
  if (!directive || job.lease.workspaceSource) throw new Error("resource_preparation_required");
  await prepareResourceFiles(work, directive.kind === "clone" ? "C:\\AgentSource" : undefined);
  return { stdout: "", stderr: "", code: 0, timedOut: false, truncated: false };
}
const result = await (process.argv[3] === "prepare" ? prepare() : execute()).catch((error: unknown): ExecResult => ({ stdout: "", stderr: error instanceof Error ? error.message.slice(-65536) : "guest_execution_failed", code: 1, timedOut: false, truncated: false }));
let encoded = JSON.stringify({ kind: "completed", result });
while (Buffer.byteLength(encoded) > MAX_CONTROL_BYTES - 1024) {
  result.stdout = result.stdout.slice(Math.ceil(result.stdout.length / 2));
  result.stderr = result.stderr.slice(Math.ceil(result.stderr.length / 2));
  result.truncated = true;
  encoded = JSON.stringify({ kind: "completed", result });
}
// 直接写预建文件，不 rename；宿主只从启动 VM 前持有的句柄读取。
await fs.writeFile("C:\\AgentOutput\\outcome.json", encoded, "utf8");
