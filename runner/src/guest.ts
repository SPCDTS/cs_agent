import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJson } from "./files.ts";
import { GuestInput, MAX_WSB_RESULT_BYTES, parse } from "./wsb-evidence.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("wsb_guest_paths_required");
const job = parse(GuestInput, await readJson(input, 512 * 1024));
const work = "C:\\AgentWork";
const env = { ...process.env, PATH: "C:\\AgentRuntime;" + process.env.PATH,
  npm_config_cache: "C:\\AgentCache\\npm", npm_config_update_notifier: "false", CI: "true" };

async function run() {
  if (Date.now() >= job.deadline) throw new Error("wsb_execution_expired");
  await fs.mkdir(work, { recursive: true });
  const cwd = path.resolve(work, job.cwd ?? ".");
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error("not_a_directory");
  const script = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
    "$OutputEncoding = [Console]::OutputEncoding; $ErrorActionPreference='Stop'; $global:LASTEXITCODE=0;\r\n" + job.script + "\r\nexit $LASTEXITCODE\r\n";
  const file = path.join("C:\\Windows\\Temp", "cs-agent-" + randomUUID() + ".ps1");
  await fs.writeFile(file, "\uFEFF" + script, { encoding: "utf8", flag: "wx" });
  try {
    return await new Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }>((resolve, reject) => {
      const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
        { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const limit = 65536;
      const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      let truncated = false;
      const append = (stream: keyof typeof tails, chunk: Buffer) => {
        if (tails[stream].length + chunk.length > limit) truncated = true;
        tails[stream] = Buffer.concat([tails[stream], chunk]).subarray(-limit);
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", reject);
      child.once("close", code => resolve({
        stdout: tails.stdout.toString("utf8"), stderr: tails.stderr.toString("utf8"),
        exitCode: code ?? 1, truncated,
      }));
    });
  } finally {
    await fs.unlink(file).catch(() => undefined);
  }
}

const result = await run().catch((error: unknown) => ({
  stdout: "", stderr: error instanceof Error ? error.message.slice(-65536) : "wsb_guest_execution_failed",
  exitCode: 1, truncated: false,
}));
let encoded = JSON.stringify({ id: job.id, result });
while (Buffer.byteLength(encoded) > MAX_WSB_RESULT_BYTES) {
  result.stdout = result.stdout.slice(Math.ceil(result.stdout.length / 2));
  result.stderr = result.stderr.slice(Math.ceil(result.stderr.length / 2));
  result.truncated = true;
  encoded = JSON.stringify({ id: job.id, result });
}
// Windows Sandbox shares a directory. The host holds the original file open
// before sharing and never resolves a guest-writable result path.
await fs.writeFile(output, encoded, "utf8");
