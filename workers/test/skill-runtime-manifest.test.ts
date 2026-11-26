import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { TokenVault } from "../src/mcp/crypto";
import { parseSkill } from "../src/skills";
import { hasNpmLockFiles, SkillGroupSchema, SkillNameSchema } from "../src/skill-runtime/manifest";

describe("skill-runtime helpers & crypto", () => {
  it("校验 Skill / 群名模式并检测 npm 锁文件", () => {
    expect(Check(SkillNameSchema, "my-skill-1")).toBe(true);
    expect(Check(SkillNameSchema, "../escape")).toBe(false);
    expect(Check(SkillGroupSchema, "group:200000001")).toBe(true);
    expect(Check(SkillGroupSchema, "owner")).toBe(false);

    expect(hasNpmLockFiles({ "package.json": "{}" })).toBe(false);
    expect(hasNpmLockFiles({ "package.json": "{}", "package-lock.json": "{}" })).toBe(true);
  });

  it("普通 Skill 无需 runner.json，且即使附带任意 runner.json 文本也按普通附件接收", () => {
    const plain = parseSkill("demo", "---\nname: demo\ndescription: d\n---\nbody", {
      "scripts/run.sh": "#!/bin/sh\necho ok\n",
    });
    expect(plain.name).toBe("demo");

    const withArbitraryRunner = parseSkill("demo", "---\nname: demo\ndescription: d\n---\nbody", {
      "runner.json": "{not-validated-as-manifest",
    });
    expect(withArbitraryRunner.files?.["runner.json"]).toBe("{not-validated-as-manifest");
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
