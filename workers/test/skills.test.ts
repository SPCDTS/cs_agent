import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import type { JsonObject } from "@earendil-works/pi-durable";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import worker from "../src/index";
import { ThreadDO } from "../src/thread";
import * as models from "../src/models";
import type { SkillSummary } from "../src/skills";
import { input } from "./helpers";

const TOKEN = "test-admin-only";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function admin(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`https://test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ADMIN_TOKEN: TOKEN });
}
const skillMd = (name: string, description = "压枪与急停的练习步骤") => `---\nname: ${name}\ndescription: ${description}\n---\n# 练枪\n先练急停，再练压枪。\n`;
const digest = () => env.REGISTRY.getByName("main").skillsDigest();
async function put(name: string, body: unknown) {
  const response = await admin("PUT", `/admin/skills/${name}`, body);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/** 记录每次模型请求时生效的 skills section（按系统消息重放，null 表示已撤下）与工具结果。 */
function script(steps: { name: string; args: JsonObject }[]) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const outputs: string[] = [], sections: (string | null | undefined)[] = [], tools = new Set<string>(), captured = new Set<string>();
  const respond: FauxResponseFactory = transcript => {
    faux.setResponses([respond]);
    let skills: string | null | undefined;
    for (const message of transcript.messages) if (message.role === "system") {
      if (message.sections && "skills" in message.sections) skills = message.sections.skills;
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    }
    sections.push(skills);
    const last = transcript.messages.findLast(message => message.role === "toolResult");
    if (last?.role === "toolResult" && !captured.has(last.toolCallId)) {
      captured.add(last.toolCallId);
      outputs.push(last.content.filter(block => block.type === "text").map(block => block.text).join(""));
    }
    const next = transcript.messages.at(-1)?.role === "assistant" ? undefined : steps.shift();
    return next ? fauxAssistantMessage(fauxToolCall(next.name, next.args), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation(() => {
    const registry = createModels(); registry.setProvider(faux.provider);
    return registry;
  });
  return { outputs, sections, tools, steps };
}
// 每回合新建 ThreadDO 实例：实例里的目录缓存是 60 秒，新实例代表缓存过期后的下一次请求。
const turn = (key: string, messageId: number, userId: number, groupId?: number) => runInDurableObject(env.THREAD.getByName(key),
  (_instance, state) => new ThreadDO(state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" }).submit(input(messageId, "按技能练枪", userId, groupId)));

describe("skills catalog", () => {
  it("validates PUT, keeps attachments and enablement on overwrite, and changes the digest only with the enabled catalog", async () => {
    expect((await admin("GET", "/admin/skills", undefined, null)).status).toBe(401);
    expect(await put("Bad_Name", { markdown: skillMd("Bad_Name") })).toEqual({ status: 400, body: { error: "invalid_name" } });
    expect(await put("aim", { markdown: skillMd("spray") })).toEqual({ status: 400, body: { error: "name_mismatch" } });
    expect(await put("aim", { markdown: "# 没有 frontmatter" })).toEqual({ status: 400, body: { error: "missing_frontmatter" } });
    expect(await put("aim", { markdown: "---\nname: aim\n---\n正文" })).toEqual({ status: 400, body: { error: "missing_description" } });
    expect(await put("aim", { markdown: skillMd("aim"), files: { "ref.md": "字".repeat(30_000) } })).toEqual({ status: 400, body: { error: "file_too_large" } });
    expect(await put("aim", { markdown: skillMd("aim"), files: { "../ref.md": "x" } })).toEqual({ status: 400, body: { error: "invalid_path" } });
    expect(await put("aim", { markdown: skillMd("aim"), files: { "/ref.md": "x" } })).toEqual({ status: 400, body: { error: "invalid_path" } });
    expect((await admin("GET", "/admin/skills")).status).toBe(200);
    expect(await (await admin("GET", "/admin/skills")).json()).toEqual({ skills: [] });

    const empty = await digest();
    expect(await put("aim", { markdown: skillMd("aim"), files: { "ref/notes.md": "急停要点" } }))
      .toEqual({ status: 200, body: { name: "aim", description: "压枪与急停的练习步骤", enabled: true, updatedAt: expect.any(Number), files: ["ref/notes.md"] } });
    const withAim = await digest();
    expect(withAim).not.toBe(empty);
    const list = await (await admin("GET", "/admin/skills")).json<{ skills: (SkillSummary & { body?: string })[] }>();
    expect(list.skills).toHaveLength(1);
    expect(list.skills[0]).not.toHaveProperty("body");

    expect((await admin("POST", "/admin/skills/aim/disable")).status).toBe(200);
    expect(await digest()).toBe(empty);
    // 停用期间改正文：仍停用、附件保留；正文变了但目录（名称与描述）没变，digest 不变。
    expect((await put("aim", { markdown: skillMd("aim") + "补充一段。" })).body).toMatchObject({ enabled: false, files: ["ref/notes.md"] });
    expect(await digest()).toBe(empty);
    expect((await admin("POST", "/admin/skills/aim/enable")).status).toBe(200);
    expect(await digest()).toBe(withAim);
    expect((await put("aim", { markdown: skillMd("aim", "新的描述") })).status).toBe(200);
    expect(await digest()).not.toBe(withAim);
    expect(await (await admin("GET", "/admin/skills/aim")).json()).toMatchObject({ body: skillMd("aim", "新的描述"), files: { "ref/notes.md": "急停要点" } });

    expect((await admin("DELETE", "/admin/skills/aim")).status).toBe(200);
    expect((await admin("DELETE", "/admin/skills/aim")).status).toBe(404);
    expect((await admin("POST", "/admin/skills/aim/enable")).status).toBe(404);
    expect((await admin("GET", "/admin/skills/aim")).status).toBe(404);
    expect(await digest()).toBe(empty);
  });

  it("lists enabled skills in the skills section, serves read_skill with truncation, and drops a disabled skill", async () => {
    const long = "a".repeat(30_000);
    expect((await put("aim", { markdown: skillMd("aim"), files: { "ref/notes.md": "急停要点", "long.txt": long } })).status).toBe(200);
    expect((await put("spray", { markdown: skillMd("spray", "<控枪> & 弹道") })).status).toBe(200);
    expect((await admin("POST", "/admin/skills/spray/disable")).status).toBe(200);
    const seen = script([
      { name: "read_skill", args: { name: "aim" } },
      { name: "read_skill", args: { name: "aim", path: "ref/notes.md" } },
      { name: "read_skill", args: { name: "aim", path: "long.txt" } },
      { name: "read_skill", args: { name: "aim", path: "missing.md" } },
      { name: "read_skill", args: { name: "nobody" } },
      { name: "read_skill", args: { name: "spray" } },
    ]);
    expect(await turn("owner", 1, 10000001)).toEqual({ status: "done" });
    expect(seen.tools).toContain("read_skill");
    expect(seen.outputs[0]).toBe(skillMd("aim"));
    expect(seen.outputs[1]).toBe("急停要点");
    expect(seen.outputs[2]).toBe("a".repeat(20_000) + "\n…（已截断，全文 30000 字）");
    expect(seen.outputs[3]).toContain("没有文件 missing.md");
    expect(seen.outputs[3]).toContain("ref/notes.md");
    expect(seen.outputs[4]).toBe("技能 nobody 不存在或已停用。");
    expect(seen.outputs[5]).toBe("技能 spray 不存在或已停用。");
    const section = seen.sections.at(-1);
    expect(section).toContain("<available_skills>");
    expect(section).toContain("<name>aim</name>\n<description>压枪与急停的练习步骤</description>");
    expect(section).not.toContain("spray");
    expect(section).not.toContain("先练急停");

    expect((await admin("POST", "/admin/skills/aim/disable")).status).toBe(200);
    seen.steps.push({ name: "read_skill", args: { name: "aim" } });
    seen.outputs.length = 0;
    expect(await turn("owner", 2, 10000001)).toEqual({ status: "done" });
    expect(seen.sections.at(-1) ?? null).toBeNull();
    expect(seen.outputs[0]).toBe("技能 aim 不存在或已停用。");
  });

  it("serves the same catalog and read_skill in group threads", async () => {
    expect((await put("aim", { markdown: skillMd("aim") })).status).toBe(200);
    const seen = script([{ name: "read_skill", args: { name: "aim" } }]);
    expect(await turn("group:200000001", 1, 10000004, 200000001)).toEqual({ status: "done" });
    expect(seen.outputs[0]).toBe(skillMd("aim"));
    expect(seen.sections.at(-1)).toContain("<name>aim</name>");
  });
});
