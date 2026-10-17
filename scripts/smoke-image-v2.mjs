// 显式运行的本机 ComfyUI 冒烟；不调用模型代理、Codex 或 QQ，不读取 .env。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpImageBackend } from "../dist/agent/image-gen.js";

if (process.env.COMFY_MODE !== "http") throw new Error("请显式设置 COMFY_MODE=http");
const root = path.resolve("data/imgv2-smoke");
await mkdir(root, { recursive: true });
const reportPath = path.join(root, "results.json");
const results = JSON.parse(await readFile(reportPath, "utf8").catch(() => "[]"));
const backend = new HttpImageBackend({ baseUrl: "http://127.0.0.1:8188", timeoutMs: 300000 });
const cases = [
  ["t2i", { prompt: "一只橘猫坐在蓝色陶瓷杯旁，柔和自然光，简洁摄影", seed: 2026101801 }],
  ["wide", { prompt: "雪地里的橘猫，远处松林，横向摄影构图", aspect: "16:9", seed: 2026101802 }],
  ["2k", { prompt: "白色陶瓷茶壶与绿茶杯，柔和侧光，细腻产品摄影", size: "2k", seed: 2026101803 }],
  ["transparent", { prompt: "一只可爱的橘猫贴纸，只有猫，透明背景", transparent: true, seed: 2026101804 }],
  ["edit", { prompt: "把蓝色陶瓷杯改为红色，保留猫的姿态、背景和构图", seed: 2026101805 }],
];
for (const [name, base] of cases) {
  if (results.some(r => r.name === name)) continue; // 再运行只收取/执行尚未完成的项目
  const options = { ...base };
  if (name === "edit") options.reference_images = [results.find(r => r.name === "t2i").files[0].path];
  const statePath = path.join(root, name + "-job.json");
  let state = JSON.parse(await readFile(statePath, "utf8").catch(() => "null"));
  const start = Date.now();
  if (!state) {
    const id = await backend.submit(options, { filenamePrefix: "imgv2-" + name + "-" + start, referenceSubfolder: "imgv2-smoke" });
    state = { id, start, options };
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  }
  const files = await backend.collect(state.id, path.join(root, name), undefined, options);
  const details = [];
  for (const file of files) {
    const bytes = await readFile(file);
    details.push({ path: file, bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25], alpha: [4,6].includes(bytes[25]) });
  }
  const row = { name, prompt_id: state.id, ms: Date.now() - state.start, files: details };
  results.push(row);
  await writeFile(reportPath, JSON.stringify(results, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(row));
}
await backend.close();
