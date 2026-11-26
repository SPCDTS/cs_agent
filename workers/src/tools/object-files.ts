import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { SandboxReadOutput, readToolResult } from "./coding";
import { decodeFileRead } from "../sandbox/read";
import { sandboxFailure, workPath } from "../sandbox/client";
import { persistentFileKey } from "../sandbox/object-files";
import type { SandboxDO } from "../sandbox/do";

type Access = Pick<SandboxDO, "readObject" | "writeObject" | "readBlob" | "writeFile">;
const key = Type.String({ minLength: 1, description: "Private R2 key or r2:// reference returned by a tool" });
const path = Type.String({ minLength: 1, description: "File in the assigned Linux /work workspace" });
const reply = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }] });

export function objectFileTools(access: (api: ToolExecutionApi, context: Context) => Promise<Access>) {
  async function run(api: ToolExecutionApi, context: Context, fn: (store: Access) => Promise<ToolExecutionResult>) {
    try { return await fn(await access(api, context)); }
    catch (error) { return { ...reply(sandboxFailure(error)), isError: true }; }
  }
  return defineExtension({ name: "cs.object-files", tools: [
    defineTool({ name: "r2_read", callers: ["tools"], replay: "safe", structuredOutputSchema: SandboxReadOutput,
      description: "Read a private R2 object as text or image. Pass path to copy its original bytes into /work for bash.",
      parameters: Type.Object({ key, path: Type.Optional(path), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
      execute: (args, api, context) => run(api, context, async store => {
        const bytes = await store.readObject(args.key);
        if (args.path !== undefined) {
          const target = workPath(args.path);
          await store.writeFile(target, bytes, `r2-import:${api.taskId}`);
          const text = `Copied ${bytes.length} bytes to ${target}`;
          return { ...reply(text), structuredOutput: { kind: "text", text } };
        }
        return readToolResult(decodeFileRead(bytes, args));
      }) }),
    defineTool({ name: "r2_write", callers: ["tools"], replay: "unsafe",
      description: "Store text under a private R2 key, or upload an existing /work file using path. Supply exactly one of content and path. The object persists independently of bash. Keys beginning with .tmp/ are reserved for temporary outputs.",
      parameters: Type.Object({ key, content: Type.Optional(Type.String()), path: Type.Optional(path) }, { additionalProperties: false }),
      execute: (args, api, context) => run(api, context, async store => {
        if ((args.content === undefined) === (args.path === undefined)) throw new Error("invalid_request");
        const key = persistentFileKey(args.key);
        const data = args.content ?? (await store.readBlob(workPath(args.path!))).bytes;
        const result = await store.writeObject(key, data);
        return reply(JSON.stringify({ key, path: "r2://" + key, bytes: result.bytes }));
      }) }),
  ] });
}
