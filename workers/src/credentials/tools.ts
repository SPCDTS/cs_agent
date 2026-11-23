import { copyJson } from "@earendil-works/chord/json";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Env } from "../env";
import { workPath } from "../sandbox/client";
import type { WriteCredential } from "./store";
import { Binding, FILE_LIMIT, Group, Ref } from "./material";

type Registry = Pick<ReturnType<Env["REGISTRY"]["getByName"]>, "sharedCredentialList" | "sharedCredentialSave" |
  "sharedCredentialGrant" | "sharedCredentialForget" | "sharedCredentialRequest">;
type Caller = { scope: string; origin: "qq" | "web" };
type Host = {
  namespace: string;
  caller(api: ToolExecutionApi, context: Context): Promise<Caller | undefined>;
  read(path: string, maxBytes: number): Promise<Uint8Array>;
  registry: Registry;
  audit(action: string, ref: string, result: string, group?: string): Promise<unknown>;
};
const strict = { additionalProperties: false };
const path = Type.String({ minLength: 1, maxLength: 1024, description: "主人工作区中的登录文件。只传路径，勿读取、打印或粘贴内容。" });
const revision = Type.String({ minLength: 1, maxLength: 64, description: "credential_list 返回的当前 revision。" });
const resultSchema = Type.Record(Type.String(), Type.Unknown());

export function credentialExtension(host: Host) {
  const store = host.registry;
  async function run(api: ToolExecutionApi, c: Context, action: string, ref: string, work: (caller: Caller) => Promise<unknown>, group?: string) {
    let outcome = "error";
    try {
      const caller = await host.caller(api, c);
      if (!caller || caller.scope !== host.namespace || (action !== "request" && action !== "list" && caller.scope !== "owner")) throw new Error("credential_denied");
      const value = await work(caller);
      if (action === "request" && (await host.caller(api, c))?.scope !== caller.scope) throw new Error("credential_denied");
      const json = JSON.stringify(value);
      outcome = "ok";
      return { output: [{ type: "text" as const, text: json }], structuredOutput: copyJson(JSON.parse(json)) };
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      outcome = /^(credential_[a-z_]+|not_found|file_too_large|unconfigured|path_denied)$/.test(code) ? code : "credential_failed";
      return { isError: true, output: [{ type: "text" as const, text: outcome }] };
    } finally {
      if (action !== "list") await host.audit(action, ref, outcome, group).catch(() => console.warn("credential_audit_failed"));
    }
  }
  async function importFile(change: WriteCredential, source: string, api: ToolExecutionApi, c: Context) {
    const bytes = await host.read(workPath(source), FILE_LIMIT);
    if ((await host.caller(api, c))?.scope !== "owner") throw new Error("credential_denied");
    return store.sharedCredentialSave(change, bytes);
  }
  const manage = host.namespace === "owner" ? [
    defineTool({ name: "credential_import", description: "从主人的登录文件创建共享凭证，用简短服务名作为 ref。只登记主人信任的查询接口；Cookie 支持请求头或 curl cookies.txt。先询问不明确的目标，勿把凭据作为参数。",
      replay: "unsafe", structuredOutputSchema: resultSchema, parameters: Type.Object({ ref: Ref, path, binding: Binding }, strict),
      execute: (args, api, c) => run(api, c, "import", args.ref, () =>
        importFile({ ref: args.ref, binding: args.binding }, args.path, api, c)) }),
    defineTool({ name: "credential_rotate", description: "从主人工作区的新文件更新凭证，沿用原引用、绑定和群授权。",
      replay: "unsafe", structuredOutputSchema: resultSchema, parameters: Type.Object({ ref: Ref, path, expectedRevision: revision }, strict),
      execute: (args, api, c) => run(api, c, "rotate", args.ref, () =>
        importFile({ ref: args.ref, expectedRevision: args.expectedRevision }, args.path, api, c)) }),
    defineTool({ name: "credential_share", description: "按凭证授予或撤销一个群的使用权。群可查询已登记的地址。",
      replay: "unsafe", structuredOutputSchema: resultSchema, parameters: Type.Object({ ref: Ref, group: Group, allow: Type.Boolean() }, strict),
      execute: ({ ref, group, allow }, api, c) => run(api, c, allow ? "grant" : "revoke", ref, () => store.sharedCredentialGrant(ref, group, allow), group) }),
    defineTool({ name: "credential_forget", description: "删除指定版本的凭证和它的全部授权。",
      replay: "unsafe", structuredOutputSchema: resultSchema, parameters: Type.Object({ ref: Ref, expectedRevision: revision }, strict),
      execute: ({ ref, expectedRevision }, api, c) => run(api, c, "forget", ref, () => store.sharedCredentialForget(ref, expectedRevision)) }),
  ] : [];
  return defineExtension({ name: "cs.shared-credentials", namespace: { name: "credentials", description: "共享登录凭证和宿主认证 HTTP 查询" },
    tools: [...manage,
      defineTool({ name: "credential_list", description: "列出本会话可用的凭证引用和查询地址，主人另可查看版本和群授权。",
        replay: "safe", structuredOutputSchema: resultSchema, parameters: Type.Object({}, strict),
        execute: (_, api, c) => run(api, c, "list", "", async ({ scope }) => ({ credentials: await store.sharedCredentialList(scope) })) }),
      defineTool({ name: "credential_request", description: "使用凭证引用发起宿主 GET 查询。url 使用列出的 HTTPS 接口，可附查询参数；返回 status 和成功响应的文本 body。",
        replay: "unsafe", structuredOutputSchema: resultSchema, parameters: Type.Object({ ref: Ref, url: Type.String({ minLength: 1, maxLength: 4096 }) }, strict),
        execute: ({ ref, url }, api, c) => run(api, c, "request", ref, ({ scope, origin }) => store.sharedCredentialRequest(scope, ref, url, origin)) }),
    ].map(tool => ({ ...tool, callers: ["tools"] as const })),
  });
}
