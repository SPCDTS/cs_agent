/**
 * 把 Codex CLI 的 ${CODEX_HOME}/auth.json（auth_mode=chatgpt）映射为 pi-ai openai-codex 的 OAuth 凭据。
 *
 * Codex 格式: { auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }
 * pi-ai 格式: { type: "oauth", access, refresh, expires(ms), accountId }
 *
 * 每次 read/modify 都重新读文件（codex 子进程也可能刷新并写回），pi-ai 刷新后按 Codex 格式写回同一文件。
 * 写回前再读一次：若文件中的 refresh_token 已不是本次刷新所依据的那个（codex 在此期间刷新过），
 * 采用磁盘上的新 token、丢弃本次刷新结果，避免用已作废的轮换结果覆盖 codex 的写入。
 * 任何日志都不得包含 token 值。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export const CODEX_PROVIDER_ID = "openai-codex";

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

/** 解析 JWT 的 exp（秒）→ 毫秒；失败返回 0（视为已过期，触发刷新）。 */
export function jwtExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function codexFileToCredential(file: CodexAuthFile): Credential | undefined {
  const t = file.tokens;
  if (!t?.access_token || !t.refresh_token) return undefined;
  return {
    type: "oauth",
    access: t.access_token,
    refresh: t.refresh_token,
    expires: jwtExpiryMs(t.access_token),
    accountId: t.account_id,
  };
}

export function mergeCredentialIntoFile(file: CodexAuthFile, cred: Credential): CodexAuthFile {
  if (cred.type !== "oauth") return file;
  return {
    ...file,
    auth_mode: file.auth_mode ?? "chatgpt",
    tokens: {
      ...file.tokens,
      access_token: cred.access,
      refresh_token: cred.refresh,
      account_id: typeof cred.accountId === "string" ? cred.accountId : file.tokens?.account_id,
    },
    last_refresh: new Date().toISOString(),
  };
}

/** openai-codex 走文件，其余 provider 交给内存 store（API key provider 由 pi-ai 从环境变量读取）。 */
export class CodexAuthFileStore implements CredentialStore {
  private readonly fallback = new InMemoryCredentialStore();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly authFile: string) {}

  private async readFile(): Promise<CodexAuthFile | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.authFile, "utf8")) as CodexAuthFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`无法读取 ${this.authFile}: ${(err as Error).message}`);
    }
  }

  private async writeFile(content: CodexAuthFile): Promise<void> {
    await fs.mkdir(path.dirname(this.authFile), { recursive: true });
    const tmp = `${this.authFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.authFile);
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (providerId !== CODEX_PROVIDER_ID) return this.fallback.read(providerId, options);
    const file = await this.readFile();
    return file ? codexFileToCredential(file) : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const others = await this.fallback.list(options);
    const mine = (await this.read(CODEX_PROVIDER_ID)) ? [{ providerId: CODEX_PROVIDER_ID, type: "oauth" as const }] : [];
    return [...mine, ...others];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== CODEX_PROVIDER_ID) return this.fallback.modify(providerId, fn, options);
    // 进程内串行：同一时刻只有一个刷新在跑
    const run = this.chain.then(async () => {
      const file = (await this.readFile()) ?? {};
      const current = codexFileToCredential(file);
      const next = await fn(current);
      if (next === undefined) return current;
      // 刷新期间 codex 可能已轮换并写回：以磁盘为准，不覆盖
      const latest = (await this.readFile()) ?? {};
      if (latest.tokens?.refresh_token !== file.tokens?.refresh_token) {
        const adopted = codexFileToCredential(latest);
        if (adopted) return adopted;
      }
      await this.writeFile(mergeCredentialIntoFile(latest, next));
      return next;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (providerId !== CODEX_PROVIDER_ID) return this.fallback.delete(providerId, options);
    // 不删除 codex 的凭据文件（codex CLI 共用），只记录为不可用由运维处理
    throw new Error("refusing to delete shared Codex auth.json");
  }
}
