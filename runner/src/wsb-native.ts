import { spawn } from "node:child_process";
import { Type } from "typebox";
import { Check } from "typebox/value";

export const Uuid = Type.String({ pattern: "^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$" });
const StartResult = Type.Object({ Id: Uuid });
const ListResult = Type.Object({ WindowsSandboxEnvironments: Type.Array(StartResult) });
const ExecResult = Type.Object({ ExitCode: Type.Integer() });

export interface NativeWsb {
  start(id: string, configuration: string): Promise<void>;
  list(): Promise<string[]>;
  stop(id: string): Promise<void>;
  share(id: string, host: string, guest: string, writable: boolean): Promise<void>;
  exec(id: string, input: string, output: string): Promise<void>;
}

// An OS spawn error proves the CLI never received the start request. Any error
// after it was spawned can leave an in-flight request in Windows Sandbox.
export class WsbLaunchError extends Error {}

function call(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("wsb.exe", [...args, "--raw"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("wsb_cli_timeout"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 262144) chunks.push(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new WsbLaunchError("wsb_cli_unavailable"));
    });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0 || size > 262144) reject(new Error("wsb_cli_failed"));
      else resolve(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""));
    });
  });
}

export const nativeWsb: NativeWsb = {
  async start(id, configuration) {
    const value: unknown = JSON.parse(await call(["start", "--id", id, "--config", configuration], 300000));
    if (!Check(StartResult, value) || value.Id.toLowerCase() !== id) throw new Error("wsb_start_unconfirmed");
  },
  async list() {
    const value: unknown = JSON.parse(await call(["list"], 15000));
    if (!Check(ListResult, value)) throw new Error("wsb_list_unconfirmed");
    return value.WindowsSandboxEnvironments.map(row => row.Id.toLowerCase());
  },
  async stop(id) {
    await call(["stop", "--id", id], 20000);
  },
  async share(id, host, guest, writable) {
    await call(["share", "--id", id, "--host-path", host, "--sandbox-path", guest, ...(writable ? ["--allow-write"] : [])], 20000);
  },
  async exec(id, input, output) {
    const launcher = '"C:\\AgentRuntime\\node.exe" "C:\\AgentRuntime\\guest.mjs" "' + input + '" "' + output + '"';
    const value: unknown = JSON.parse(await call(["exec", "--id", id, "--run-as", "System", "--command", launcher], 1260000));
    if (!Check(ExecResult, value) || value.ExitCode !== 0) throw new Error("wsb_guest_launcher_failed");
  },
};

const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function sandboxConfiguration(runtime: string, memoryMb: number): string {
  return "<Configuration><MemoryInMB>" + memoryMb + "</MemoryInMB><Networking>Enable</Networking>" +
    "<vGPU>Disable</vGPU><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput>" +
    "<VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><MappedFolders>" +
    "<MappedFolder><HostFolder>" + xml(runtime) + "</HostFolder><SandboxFolder>C:\\AgentRuntime</SandboxFolder>" +
    "<ReadOnly>true</ReadOnly></MappedFolder></MappedFolders></Configuration>";
}
