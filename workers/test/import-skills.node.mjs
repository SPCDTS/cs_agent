import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("技能目录转成 PUT 请求体：收子目录里的文本附件，跳过二进制、缓存目录与超过 64 KiB 的文件", () => {
  const root = mkdtempSync(path.join(process.env.EXPORT_TEST_TMP ?? tmpdir(), "skills-import-"));
  try {
    const dir = path.join(root, "data", "skills", "aim");
    mkdirSync(path.join(dir, "ref"), { recursive: true });
    mkdirSync(path.join(dir, "__pycache__"));
    const markdown = "---\nname: aim\ndescription: 压枪练习\n---\n正文\n";
    writeFileSync(path.join(dir, "SKILL.md"), markdown, "utf8");
    writeFileSync(path.join(dir, "ref", "notes.md"), "急停要点", "utf8");
    writeFileSync(path.join(dir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(path.join(dir, "__pycache__", "x.pyc"), "cache", "utf8");
    writeFileSync(path.join(dir, "big.txt"), "a".repeat(64 * 1024 + 1), "utf8");

    const script = fileURLToPath(new URL("../scripts/import-skills.mjs", import.meta.url));
    const run = name => execFileSync(process.execPath, [script, name], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(JSON.parse(run("aim")), { markdown, files: { "ref/notes.md": "急停要点" } });
    assert.throws(() => run("missing"));
    assert.throws(() => run("../aim"));
  } finally {
    const parent = path.resolve(process.env.EXPORT_TEST_TMP ?? tmpdir());
    if (path.dirname(path.resolve(root)) !== parent || !path.basename(root).startsWith("skills-import-")) throw new Error("临时目录越界");
    rmSync(root, { recursive: true, force: true });
  }
});
