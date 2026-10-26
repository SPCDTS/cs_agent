import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogFileSink } from "../../src/shared/log-file.js";
import { log, logBuffer, setLogLevel, type LogLine } from "../../src/shared/log.js";
import { registerTemporarySecrets } from "../../src/shared/redact.js";
import { tmp } from "../agent/helpers.js";

afterEach(() => { vi.restoreAllMocks(); setLogLevel("info"); });
const line = (msg: string): LogLine => ({ t: "2026-10-26T00:00:00.000Z", level: "info", msg });

describe("日志文件出口", () => {
  it("追加 stderr 同样的脱敏 JSON 行和配置级别，关闭前排空队列", async () => {
    const file = path.join(tmp("cs-log-"), "logs", "cs-agent.jsonl");
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, JSON.stringify(line("已有日志")) + "\n", "utf8");
    const sink = createLogFileSink(file), off = logBuffer.subscribe(sink.write);
    const secret = "log-file-test-secret-778899", release = registerTemporarySecrets([secret]);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      setLogLevel("info");
      log.debug("不落盘");
      log.info("中文 " + secret, { error: new Error(secret) });
      setLogLevel("warn");
      log.info("也不落盘");
      log.warn("末行");
      off(); await sink.close();
      const text = await fs.readFile(file, "utf8");
      expect(text).toBe(JSON.stringify(line("已有日志")) + "\n" + stderr.mock.calls.map(args => args[0]).join(""));
      expect(text).not.toContain(secret);
      expect(text).not.toContain("不落盘");
      expect(text.trim().split("\n").map(s => JSON.parse(s).msg)).toEqual(["已有日志", "中文 [已隐藏]", "末行"]);
    } finally { off(); await sink.close(); release(); }
  });

  it("按 UTF-8 字节阈值轮转，重启续写并且只保留三份旧文件", async () => {
    const file = path.join(tmp("cs-log-"), "cs-agent.jsonl");
    const bytes = Buffer.byteLength(JSON.stringify(line("中文0")) + "\n");
    let sink = createLogFileSink(file, bytes * 2);
    sink.write(line("中文0")); sink.write(line("中文1"));
    await sink.close();
    expect((await fs.stat(file)).size).toBe(bytes * 2);
    await expect(fs.stat(file + ".1")).rejects.toThrow();
    sink = createLogFileSink(file, bytes * 2);
    for (let i = 2; i < 10; i++) sink.write(line("中文" + i));
    await sink.close();
    expect((await fs.readdir(path.dirname(file))).sort()).toEqual(["cs-agent.jsonl", "cs-agent.jsonl.1", "cs-agent.jsonl.2", "cs-agent.jsonl.3"]);
    for (let i = 0; i < 4; i++) {
      const text = await fs.readFile(i ? `${file}.${i}` : file, "utf8");
      expect(text.trim().split("\n").map(s => JSON.parse(s).msg)).toEqual([`中文${8 - i * 2}`, `中文${9 - i * 2}`]);
    }
  });

  it("文件系统错误不会抛入日志，下一行仍可恢复写入", async () => {
    const dir = tmp("cs-log-"), parent = path.join(dir, "logs"), file = path.join(parent, "cs-agent.jsonl");
    await fs.writeFile(parent, "阻挡目录", "utf8");
    const broken = createLogFileSink(file);
    expect(() => broken.write(line("失败"))).not.toThrow();
    await expect(broken.close()).resolves.toBeUndefined();
    await fs.unlink(parent);
    const sink = createLogFileSink(file, 1);
    sink.write(line("第一行"));
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("轮转故障"));
    sink.write(line("轮转失败")); sink.write(line("恢复"));
    await expect(sink.close()).resolves.toBeUndefined();
    rename.mockRestore();
    expect(JSON.parse(await fs.readFile(file, "utf8")).msg).toBe("恢复");
    expect(JSON.parse(await fs.readFile(file + ".1", "utf8")).msg).toBe("第一行");
  });
});
