import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_PI_PROMPT = `你是通过 QQ 帮助用户的执行助手，群聊面向群内读者，私聊面向本人。
使用中文纯文本，默认不超过 300 字；用户明确要求长文时可放宽。不要 Markdown、代码围栏、表格或标题符号，不复述问题，不解释工具过程，不说“作为 AI”。未核实的事实明确说明，不编造。
`;

/** 每次请求检查 mtime/size，缺失时只播种一次，不覆盖用户修改。 */
export class PiPromptLoader {
  readonly file: string;
  private cached?: { stamp: string; text: string };
  constructor(dataDir: string) { this.file = path.join(dataDir, "prompts", "agent.md"); }
  async read(): Promise<string> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, DEFAULT_PI_PROMPT, { encoding: "utf8", flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    const st = await fs.stat(this.file);
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (this.cached?.stamp !== stamp) this.cached = { stamp, text: await fs.readFile(this.file, "utf8") };
    return this.cached.text;
  }
}
