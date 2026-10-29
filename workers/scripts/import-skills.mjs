import { readFileSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 与 Worker 的 PUT /admin/skills/:name 限额一致。
const FILE_BYTES = 64 * 1024, FILES_BYTES = 512 * 1024;
const text = bytes => {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
};

/** 读 data/skills/<name>，返回 PUT 请求体 { markdown, files }；二进制与超限文件跳过并经 skipped 告知。 */
export function readSkill(name, dataDir = path.resolve("data")) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("技能名只能是小写字母、数字和连字符");
  const root = path.join(dataDir, "skills", name);
  const markdown = text(readFileSync(path.join(root, "SKILL.md")));
  if (markdown === undefined) throw new Error("SKILL.md 必须是 UTF-8 文本");
  const files = {}, skipped = [];
  let total = 0;
  const visit = dir => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".") || entry === "__pycache__" || entry === "node_modules") continue;
      const file = path.join(dir, entry), relative = path.relative(root, file).split(path.sep).join("/"), info = lstatSync(file);
      if (info.isSymbolicLink()) { skipped.push({ path: relative, reason: "link" }); continue; }
      if (info.isDirectory()) { visit(file); continue; }
      if (!info.isFile() || relative === "SKILL.md") continue;
      if (info.size > FILE_BYTES) { skipped.push({ path: relative, reason: "too_large" }); continue; }
      const content = text(readFileSync(file));
      if (content === undefined) { skipped.push({ path: relative, reason: "binary" }); continue; }
      if ((total += Buffer.byteLength(content)) > FILES_BYTES) throw new Error("附件合计超过 512 KiB");
      files[relative] = content;
    }
  };
  visit(root);
  return { body: { markdown, files }, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("usage");
    const { body, skipped } = readSkill(process.argv[2]);
    for (const file of skipped) process.stderr.write(`跳过 ${file.path}（${file.reason}）\n`, "utf8");
    process.stdout.write(JSON.stringify(body) + "\n", "utf8");
  } catch (error) {
    process.stderr.write(`读取失败：请在仓库根目录执行 node workers/scripts/import-skills.mjs <技能名>，并检查 data/skills/<技能名>/SKILL.md。${error instanceof Error && error.message !== "usage" ? "（" + error.message + "）" : ""}\n`, "utf8");
    process.exitCode = 1;
  }
}
