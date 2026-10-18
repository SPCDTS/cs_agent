import { promises as fs } from "node:fs";
import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ShellExecOptions } from "@earendil-works/pi-durable/env";
import { createCodingTools, DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { isScope } from "../../context/access.js";

export const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash"]);
const SHELL_ENV = /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_.*|TZ|TERM|TMPDIR)$/;

/** 文件工具不设路径沙箱；只约束子进程的凭据继承与单次运行时间。 */
export class PiExecutionEnv extends NodeExecutionEnv {
  override exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
    return super.exec(command, { ...options, inheritEnv: false,
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
        SHELL_ENV.test(entry[0]) && entry[1] !== undefined)), ...options?.env },
      timeout: Math.min(60, options?.timeout ?? 60),
    }, context);
  }
}

export async function codingEnvironment(dataDir: string, key: string): Promise<PiExecutionEnv> {
  if (key !== "owner" && !isScope(key)) throw new Error("pi 工作目录缺少有效会话键");
  const cwd = path.resolve(dataDir, "pi-work", key.replace(/:/g, "_"));
  await fs.mkdir(cwd, { recursive: true });
  return new PiExecutionEnv({ cwd });
}

export async function codingTools() {
  const images = await createNodePhotonImages();
  return createCodingTools({ images: {
    prepare: (bytes, mimeType) => images.prepare(bytes, mimeType, DEFAULT_IMAGE_LIMITS),
  } });
}
