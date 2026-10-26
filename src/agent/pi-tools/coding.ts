import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { err, ok, ExecutionError, FileError, type DirReader, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { createBashTool, createCodingTools, DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { BWRAP, bwrapArgs, PiPathPolicy, requireBwrap, type PiSandboxOptions } from "./sandbox.js";

export const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash"]);
const SHELL_ENV = /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_.*|TZ|TERM|TMPDIR)$/;

type EnvArgs<K extends keyof NodeExecutionEnv> = NodeExecutionEnv[K] extends (...args: infer A) => unknown ? A : never;

/** 每次工具调用绑定一个持久化请求快照，不保留跨回合可变的身份。 */
export class PiExecutionEnv extends NodeExecutionEnv {
  constructor(readonly policy: PiPathPolicy) { super({ cwd: policy.workspace }); }

  override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    try {
      context.abortSignal?.throwIfAborted();
      await requireBwrap();
      const deny = await this.policy.deny();
      await this.policy.check(this.cwd, "write", deny);
      if (options?.cwd && path.resolve(this.cwd, options.cwd) !== this.policy.workspace) throw new Error("bash cwd 必须是本会话工作区；请在沙箱命令内 cd");
      const timeout = options?.timeout;
      return await super.exec([BWRAP, ...bwrapArgs(this.policy.workspace, this.policy.workRoot, deny.paths, command)], {
        ...options, cwd: this.policy.workspace, inheritEnv: false,
        env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
          SHELL_ENV.test(entry[0]) && entry[1] !== undefined)), ...options?.env },
        timeout: typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? Math.min(60, timeout) : 60,
      }, context);
    } catch (error) {
      return err(new ExecutionError(context.abortSignal?.aborted ? "aborted" : "spawn_error", `pi bash 沙箱不可用：${String(error)}`));
    }
  }

  private async file<T>(file: string, mode: "read" | "write", context: Context, run: (canonical: string) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
    try {
      context.abortSignal?.throwIfAborted();
      return await run(await this.policy.check(file, mode));
    } catch (error) {
      return err(new FileError(context.abortSignal?.aborted ? "aborted" : "permission_denied", String(error), file));
    }
  }

  override readTextFile(...[file, ctx]: EnvArgs<"readTextFile">) { return this.file(file, "read", ctx, p => super.readTextFile(p, ctx)); }
  override readTextLines(...[file, opts, ctx]: EnvArgs<"readTextLines">) { return this.file(file, "read", ctx, p => super.readTextLines(p, opts, ctx)); }
  override openTextLineReader(...[file, ctx]: EnvArgs<"openTextLineReader">) { return this.file(file, "read", ctx, p => super.openTextLineReader(p, ctx)); }
  override readBinaryFile(...[file, ctx]: EnvArgs<"readBinaryFile">) { return this.file(file, "read", ctx, p => super.readBinaryFile(p, ctx)); }
  override openBinaryReader(...[file, opts, ctx]: EnvArgs<"openBinaryReader">) { return this.file(file, "read", ctx, p => super.openBinaryReader(p, opts, ctx)); }
  override fileInfo(...[file, ctx]: EnvArgs<"fileInfo">) { return this.file(file, "read", ctx, p => super.fileInfo(p, ctx)); }
  override exists(...[file, ctx]: EnvArgs<"exists">) { return this.file(file, "read", ctx, p => super.exists(p, ctx)); }
  // 文件锁需要规范化尚未创建的目标；policyRealpath 已解析最近的存在父目录及悬空链接。
  override canonicalPath(...[file, ctx]: EnvArgs<"canonicalPath">) { return this.file(file, "read", ctx, async p => ok<string, FileError>(p)); }
  override writeFile(...[file, content, ctx]: EnvArgs<"writeFile">) { return this.file(file, "write", ctx, p => super.writeFile(p, content, ctx)); }
  override appendFile(...[file, content, ctx]: EnvArgs<"appendFile">) { return this.file(file, "write", ctx, p => super.appendFile(p, content, ctx)); }
  override truncateFile(...[file, size, ctx]: EnvArgs<"truncateFile">) { return this.file(file, "write", ctx, p => super.truncateFile(p, size, ctx)); }
  override flushFile(...[file, ctx]: EnvArgs<"flushFile">) { return this.file(file, "write", ctx, p => super.flushFile(p, ctx)); }
  override renameFile(...[from, to, ctx]: EnvArgs<"renameFile">) {
    return this.file(from, "write", ctx, source => this.file(to, "write", ctx, destination => super.renameFile(source, destination, ctx)));
  }
  override createDir(...[file, opts, ctx]: EnvArgs<"createDir">) { return this.file(file, "write", ctx, p => super.createDir(p, opts, ctx)); }
  override remove(...[file, opts, ctx]: EnvArgs<"remove">) { return this.file(file, "write", ctx, p => super.remove(p, opts, ctx)); }

  override listDir(...[file, ctx]: EnvArgs<"listDir">) {
    return this.file(file, "read", ctx, async p => {
      const result = await super.listDir(p, ctx);
      if (!result.ok) return result;
      const visible = await Promise.all(result.value.map(async info => (await this.fileInfo(info.path, ctx)).ok));
      return ok(result.value.filter((_, index) => visible[index]));
    });
  }
  override openDirReader(...[file, ctx]: EnvArgs<"openDirReader">) {
    return this.file(file, "read", ctx, async p => {
      const result = await super.openDirReader(p, ctx);
      if (!result.ok) return result;
      const reader = result.value;
      return ok<DirReader, FileError>({ close: (context: Context) => reader.close(context), next: async (max: number, context: Context) => {
        const page = await reader.next(max, context);
        if (!page.ok) return page;
        const visible = await Promise.all(page.value.entries.map(async info => (await this.fileInfo(info.path, context)).ok));
        return ok({ ...page.value, entries: page.value.entries.filter((_, index) => visible[index]) });
      } });
    });
  }
  // 内置 coding 工具不使用 watch；关闭递归监听，避免从可读父目录观察禁读子树。
  override async watch(..._args: EnvArgs<"watch">) { return err<never, FileError>(new FileError("not_supported", "pi 沙箱不提供文件监听")); }
  override createTempDir(...[prefix, ctx]: EnvArgs<"createTempDir">) {
    if (prefix && !/^[\w-]+$/.test(prefix)) return Promise.resolve(err<string, FileError>(new FileError("invalid", "非法临时目录前缀")));
    return this.file(path.join(this.policy.workspace, (prefix ?? "tmp-") + randomUUID()), "write", ctx, async p => {
      await fs.mkdir(p); return ok(p);
    });
  }
  override async createTempFile(...[opts, ctx]: EnvArgs<"createTempFile">) {
    const dir = await this.createTempDir(undefined, ctx);
    if (!dir.ok) return dir;
    if ([opts?.prefix, opts?.suffix].some(v => v && !/^[\w.-]+$/.test(v))) return err<string, FileError>(new FileError("invalid", "非法临时文件名"));
    const file = path.join(dir.value, `${opts?.prefix ?? ""}${randomUUID()}${opts?.suffix ?? ""}`);
    const written = await this.writeFile(file, "", ctx);
    return written.ok ? ok<string, FileError>(file) : written;
  }
}

export async function codingEnvironment(options: PiSandboxOptions): Promise<PiExecutionEnv> {
  const dataDir = await fs.realpath(options.dataDir);
  const policy = new PiPathPolicy({ ...options, dataDir });
  await fs.mkdir(policy.workspace, { recursive: true });
  if (await fs.realpath(policy.workspace) !== policy.workspace) throw new Error("pi 会话工作区不能是符号链接");
  return new PiExecutionEnv(policy);
}

export async function codingTools() {
  const images = await createNodePhotonImages();
  const coding = createCodingTools({ images: {
    prepare: (bytes, mimeType) => images.prepare(bytes, mimeType, DEFAULT_IMAGE_LIMITS),
  } });
  const bash = createBashTool();
  bash.description += " 单条命令最长 60 秒，未指定 timeout 时也为 60 秒。";
  const timeout = { ...bash.parameters.properties.timeout, description: "超时秒数（可选，默认 60 秒，最长 60 秒）。" };
  bash.parameters = { ...bash.parameters, properties: { ...bash.parameters.properties, timeout } };
  return { ...coding, tools: coding.tools?.map(tool => tool.name === "bash" ? bash : tool) };
}
