// 假 comfy-mcp：stdio MCP server，暴露 server_info / generate_image / job / fetch_outputs。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const calls = [];
const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const server = new McpServer({ name: "fake-comfy", version: "0.0.1" });

server.tool("server_info", {}, async () => text({ running: true, url: process.env.COMFYUI_URL }));
server.tool(
  "generate_image",
  { prompt: z.string(), wait: z.boolean().default(true), checkpoint: z.string().nullable().optional(), timeout_seconds: z.number().default(600) },
  async (args) => {
    calls.push(["generate_image", args]);
    if (args.prompt.includes("FAIL")) return { content: [{ type: "text", text: "boom" }], isError: true };
    return text({ prompt_id: "pid-1", status: "queued", wait: args.wait });
  },
);
server.tool(
  "run_workflow",
  { workflow_path: z.string(), wait: z.boolean().default(true), timeout_seconds: z.number().default(110), confirm_spend: z.boolean().default(false) },
  async (args) => {
    const { readFileSync } = await import("node:fs");
    calls.push(["run_workflow", { ...args, workflow: JSON.parse(readFileSync(args.workflow_path, "utf8")) }]);
    return text({ prompt_id: "pid-1", status: "queued" });
  },
);
let waits = 0;
server.tool(
  "job",
  { action: z.string().default("status"), prompt_id: z.string().default(""), timeout_seconds: z.number().nullable().optional() },
  async (args) => {
    calls.push(["job", args]);
    waits++;
    if (waits % 2 === 1) return text({ timed_out: true, status: { status: "running" } });
    return text({ prompt_id: args.prompt_id, status: "success", outputs: {} });
  },
);
server.tool(
  "fetch_outputs",
  { prompt_id: z.string(), out_dir: z.string(), url_only: z.boolean().default(false), inline_images: z.boolean().default(false) },
  async (args) => {
    calls.push(["fetch_outputs", args]);
    mkdirSync(args.out_dir, { recursive: true });
    writeFileSync(path.join(args.out_dir, "ComfyUI_00001_.png"), PNG);
    writeFileSync(path.join(args.out_dir, "calls.json"), JSON.stringify(calls));
    return text([{ files: ["ComfyUI_00001_.png"] }]);
  },
);
await server.connect(new StdioServerTransport());
