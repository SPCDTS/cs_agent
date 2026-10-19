import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAuthFileStore, codexFileToCredential, jwtExpiryMs } from "../../src/agent/codex/oauth.js";
import { loadConfig } from "../../src/config.js";
import { tmp } from "./helpers.js";

const jwt = (payload: object) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

describe("codex auth.json ↔ pi-ai openai-codex credential", () => {
  const exp = 2_000_000_000;
  const file = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "idt", access_token: jwt({ exp }), refresh_token: "r1", account_id: "acc" },
    last_refresh: "2026-01-01T00:00:00Z",
  };

  it("maps fields", () => {
    expect(jwtExpiryMs(file.tokens.access_token)).toBe(exp * 1000);
    expect(codexFileToCredential(file)).toEqual({
      type: "oauth",
      access: file.tokens.access_token,
      refresh: "r1",
      expires: exp * 1000,
      accountId: "acc",
    });
  });

  it("modify() writes refreshed tokens back in Codex format, keeping other fields", async () => {
    const p = path.join(tmp(), "auth.json");
    writeFileSync(p, JSON.stringify(file));
    const store = new CodexAuthFileStore(p);
    const newAccess = jwt({ exp: exp + 10 });
    await store.modify("openai-codex", async (cur) => {
      expect(cur?.type).toBe("oauth");
      return { type: "oauth", access: newAccess, refresh: "r2", expires: (exp + 10) * 1000, accountId: "acc" };
    });
    const saved = JSON.parse(readFileSync(p, "utf8"));
    expect(saved.auth_mode).toBe("chatgpt");
    expect(saved.tokens).toEqual({ id_token: "idt", access_token: newAccess, refresh_token: "r2", account_id: "acc" });
    expect(saved.last_refresh).not.toBe(file.last_refresh);
    expect((await store.read("openai-codex"))?.type).toBe("oauth");
    expect(await store.read("anthropic")).toBeUndefined();
  });

  it("modify() adopts tokens codex wrote during our refresh instead of overwriting them", async () => {
    const p = path.join(tmp(), "auth.json");
    writeFileSync(p, JSON.stringify(file));
    const store = new CodexAuthFileStore(p);
    const codexAccess = jwt({ exp: exp + 20 });
    const result = await store.modify("openai-codex", async () => {
      // 模拟容器内 codex 在我们刷新期间完成了自己的刷新并写回
      writeFileSync(p, JSON.stringify({ ...file, tokens: { ...file.tokens, access_token: codexAccess, refresh_token: "r-codex" } }));
      return { type: "oauth", access: jwt({ exp: exp + 10 }), refresh: "r2", expires: (exp + 10) * 1000, accountId: "acc" };
    });
    expect(result).toMatchObject({ type: "oauth", access: codexAccess, refresh: "r-codex" });
    const saved = JSON.parse(readFileSync(p, "utf8"));
    expect(saved.tokens.refresh_token).toBe("r-codex");
    expect(saved.tokens.access_token).toBe(codexAccess);
  });
});

describe("config", () => {
  it("defaults and lists", () => {
    const c = loadConfig({ QQ_ALLOW_USERS: "1, 2", QQ_ALLOW_GROUPS: "3", DATA_DIR: "/d" });
    expect(c.allowUsers).toEqual(["1", "2"]);
    expect(c.QQ_ALLOW_GROUPS).toEqual(["3"]);
    expect(c.AGENT_MODEL_ID).toBe("deepseek-flash");
    expect(c.COMFY_MODE).toBe("mcp");
    expect(c.AGENT_CONCURRENCY).toBe(2);
    expect(c.codexHome).toBe(path.join("/d", "codex"));
    expect(loadConfig({ QQ_ALLOW_USERS: "*" }).allowUsers).toBe("*");
    expect(() => loadConfig({ COMFY_MODE: "bogus" })).toThrow(/配置无效/);
  });
});
