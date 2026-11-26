import { describe, expect, it } from "vitest";
import { TokenVault } from "../src/mcp/crypto";
import { parseSkill, SkillError } from "../src/skills";
import { normalizeSkillScriptArgv, parseSkillRunner, validateSkillActionArgs } from "../src/skill-runtime/manifest";

const VALID_RUNNER = JSON.stringify({
  version: 1,
  authExitCode: 41,
  actions: {
    login: { command: ["python3", "scripts/login.py"], description: "登录", ownerOnly: true, timeoutSec: 90 },
    query: {
      command: ["scripts/query.sh", "--json"],
      description: "查询",
      argsSchema: {
        type: "object",
        properties: {
          keyword: { type: "string", minLength: 1, maxLength: 50 },
          page: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["keyword"],
        additionalProperties: false,
      },
    },
  },
});

describe("skill-runtime manifest & crypto", () => {
  it("解析合法 runner.json，缺少时返回 undefined", () => {
    expect(parseSkillRunner({ "scripts/query.sh": "#!/bin/sh\necho ok\n" })).toBeUndefined();
    const runner = parseSkillRunner({
      "runner.json": VALID_RUNNER,
      "scripts/login.py": "print('ok')",
      "scripts/query.sh": "#!/bin/sh\necho ok\n",
    });
    expect(runner?.authExitCode).toBe(41);
    expect(runner?.actions.login?.ownerOnly).toBe(true);
    expect(normalizeSkillScriptArgv(runner!.actions.login!.command, "/opt/skill")).toEqual(["python3", "scripts/login.py"]);
    expect(normalizeSkillScriptArgv(runner!.actions.query!.command, "/opt/skill/")).toEqual(["/opt/skill/scripts/query.sh", "--json"]);
  });

  it("拒绝非法 runner.json（缺失脚本、路径穿越、缺失 npm 锁文件、坏 schema）并在 parseSkill 中拦截", () => {
    const cases: Array<Record<string, string>> = [
      { "runner.json": "{bad json" },
      { "runner.json": JSON.stringify({ version: 2, actions: { a: { command: ["node"], description: "x" } } }) },
      { "runner.json": JSON.stringify({ version: 1, actions: { BadName: { command: ["node"], description: "x" } } }) },
      { "runner.json": JSON.stringify({ version: 1, actions: { a: { command: ["../escape.sh"], description: "x" } } }) },
      { "runner.json": JSON.stringify({ version: 1, actions: { a: { command: ["scripts/missing.sh"], description: "x" } } }) },
      { "runner.json": JSON.stringify({ version: 1, deps: { kind: "npm" }, actions: { a: { command: ["node", "index.js"], description: "x" } } }), "package.json": "{}" },
      { "runner.json": JSON.stringify({ version: 1, actions: { a: { command: ["node"], description: "x", argsSchema: { type: "string" } } } }) },
    ];
    for (const files of cases) {
      expect(() => parseSkillRunner(files)).toThrow("invalid_runner");
      expect(() => parseSkill("demo", "---\nname: demo\ndescription: d\n---\nbody", files)).toThrow(SkillError);
    }
    const withDeps = parseSkillRunner({
      "runner.json": JSON.stringify({ version: 1, deps: { kind: "npm" }, actions: { a: { command: ["node", "index.js"], description: "x" } } }),
      "package.json": "{}",
      "package-lock.json": "{}",
    });
    expect(withDeps?.deps?.kind).toBe("npm");
  });

  it("严格校验 action 参数并拒绝未声明 argsSchema 时的多余字段", () => {
    const runner = parseSkillRunner({
      "runner.json": VALID_RUNNER,
      "scripts/query.sh": "#!/bin/sh\necho ok\n",
    })!;
    expect(validateSkillActionArgs(runner.actions.login!, undefined)).toEqual({});
    expect(validateSkillActionArgs(runner.actions.login!, {})).toEqual({});
    expect(() => validateSkillActionArgs(runner.actions.login!, { extra: 1 })).toThrow("skill_invalid_args");

    expect(validateSkillActionArgs(runner.actions.query!, { keyword: "test", page: 2 })).toEqual({ keyword: "test", page: 2 });
    expect(() => validateSkillActionArgs(runner.actions.query!, {})).toThrow("skill_invalid_args");
    expect(() => validateSkillActionArgs(runner.actions.query!, { keyword: "test", extra: true })).toThrow("skill_invalid_args");
    expect(() => validateSkillActionArgs(runner.actions.query!, { keyword: "test", page: 99 })).toThrow("skill_invalid_args");
  });

  it("TokenVault.encryptBytes / decryptBytes 绑定 AAD 并拦截篡改", async () => {
    const vault = new TokenVault("01".repeat(32));
    const plain = new Uint8Array([0, 1, 2, 255, 42, 99]);
    const aad = JSON.stringify(["skill-state-blob", "shop", "deadbeef"]);
    const cipher = await vault.encryptBytes(plain, aad);
    expect(new TextDecoder().decode(cipher.subarray(0, 6))).toBe("CSENC1");
    expect(await vault.decryptBytes(cipher, aad)).toEqual(plain);

    await expect(vault.decryptBytes(cipher, JSON.stringify(["skill-state-blob", "other", "deadbeef"]))).rejects.toThrow("oauth_token");
    const tampered = Uint8Array.from(cipher);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(vault.decryptBytes(tampered, aad)).rejects.toThrow("oauth_token");
    await expect(vault.decryptBytes(cipher.subarray(0, 10), aad)).rejects.toThrow("oauth_token");
  });
});
