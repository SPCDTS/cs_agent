import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse, JobInputSchema, PowerShellInputSchema, MAX_CONTROL_BYTES, type ExecResult } from "./protocol.ts";
import { readJson } from "./files.ts";

const inputFile = process.argv[2];
if (!inputFile) throw new Error("input_required");
const job = parse(JobInputSchema, await readJson(inputFile));
if (job.tool !== "powershell") throw new Error("tool_not_registered");
const input = parse(PowerShellInputSchema, job.arguments);
const work = "C:\\AgentWork";
await fs.mkdir(work, { recursive: true });
const cwd = path.resolve(work, input.cwd ?? ".");
if (!(await fs.stat(cwd)).isDirectory()) throw new Error("not_a_directory");
const script = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; " + input.command + "\nexit $LASTEXITCODE";
const result: ExecResult = await new Promise((resolve, reject) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    cwd, windowsHide: true, env: { ...process.env, PATH: "C:\\AgentTools\\node;C:\\AgentTools\\git\\cmd;" + process.env.PATH,
      GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "C:/AgentWork",
      GIT_CONFIG_KEY_1: "safe.directory", GIT_CONFIG_VALUE_1: "C:/AgentWork/*",
      npm_config_cache: "C:\\AgentCache\\npm", npm_config_update_notifier: "false", CI: "true" }, stdio: ["ignore", "pipe", "pipe"],
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
let encoded = JSON.stringify({ kind: "completed", result });
while (Buffer.byteLength(encoded) > MAX_CONTROL_BYTES - 1024) {
  result.stdout = result.stdout.slice(Math.ceil(result.stdout.length / 2));
  result.stderr = result.stderr.slice(Math.ceil(result.stderr.length / 2));
  result.truncated = true;
  encoded = JSON.stringify({ kind: "completed", result });
}
// 直接写预建文件，不 rename；宿主只从启动 VM 前持有的句柄读取。
await fs.writeFile("C:\\AgentOutput\\outcome.json", encoded, "utf8");
