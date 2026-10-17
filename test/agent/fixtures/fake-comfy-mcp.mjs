// 假 comfy-mcp：stdio MCP server，暴露 server_info / generate_image / run_workflow / job / fetch_outputs。
// FAKE_COMFY_STATE=<file>：模拟 ComfyUI 服务端状态跨 comfy-mcp 进程保留——记录已提交的 prompt_id 与全部调用；
//   设置后 generate_image 依次返回 pid-1、pid-2…，job / fetch_outputs 对未提交过的 prompt_id 报 job_not_found。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const stateFile = process.env.FAKE_COMFY_STATE;
const loadState = () => (stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { submitted: [], calls: [] });
const saveState = (s) => stateFile && writeFileSync(stateFile, JSON.stringify(s));
const calls = [];
const record = (name, args) => {
  calls.push([name, args]);
  if (stateFile) {
    const s = loadState();
    s.calls.push([name, args]);
    saveState(s);
  }
};
const submit = () => {
  if (!stateFile) return "pid-1";
  const s = loadState();
  const id = `pid-${s.submitted.length + 1}`;
  s.submitted.push(id);
  saveState(s);
  return id;
};
const unknown = (id) => stateFile && !loadState().submitted.includes(id);
const notFound = (id) => ({ content: [{ type: "text", text: `job_not_found: unknown prompt_id ${id}` }], isError: true });
const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const server = new McpServer({ name: "fake-comfy", version: "0.0.1" });

server.tool("server_info", {}, async () => text({ running: true, url: process.env.COMFYUI_URL }));
server.tool(
  "generate_image",
  { prompt: z.string(), wait: z.boolean().default(true), checkpoint: z.string().nullable().optional(), timeout_seconds: z.number().default(600) },
  async (args) => {
    record("generate_image", args);
    if (args.prompt.includes("FAIL")) return { content: [{ type: "text", text: "boom" }], isError: true };
    return text({ prompt_id: submit(), status: "queued", wait: args.wait });
  },
);
server.tool(
  "run_workflow",
  { workflow_path: z.string(), wait: z.boolean().default(true), timeout_seconds: z.number().default(110), confirm_spend: z.boolean().default(false) },
  async (args) => {
    record("run_workflow", { ...args, workflow: JSON.parse(readFileSync(args.workflow_path, "utf8")) });
    return text({ prompt_id: submit(), status: "queued" });
  },
);
let waits = 0;
server.tool(
  "job",
  { action: z.string().default("status"), prompt_id: z.string().default(""), timeout_seconds: z.number().nullable().optional() },
  async (args) => {
    record("job", args);
    if (unknown(args.prompt_id)) return notFound(args.prompt_id);
    waits++;
    if (waits % 2 === 1) return text({ timed_out: true, status: { status: "running" } });
    return text({ prompt_id: args.prompt_id, status: "success", outputs: {} });
  },
);
server.tool(
  "fetch_outputs",
  { prompt_id: z.string(), out_dir: z.string(), url_only: z.boolean().default(false), inline_images: z.boolean().default(false) },
  async (args) => {
    record("fetch_outputs", args);
    if (unknown(args.prompt_id)) return notFound(args.prompt_id);
    mkdirSync(args.out_dir, { recursive: true });
    writeFileSync(path.join(args.out_dir, "ComfyUI_00001_.png"), PNG);
    writeFileSync(path.join(args.out_dir, "calls.json"), JSON.stringify(calls));
    return text([{ files: ["ComfyUI_00001_.png"] }]);
  },
);
await server.connect(new StdioServerTransport());
