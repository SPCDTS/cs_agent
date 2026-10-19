import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registerSecrets } from '../shared/redact.js';

/** 临时文件先写完再以硬链接发布；并发启动只接受首个已发布口令。 */
export async function loadObsToken(dataDir: string, envToken = '', generated: (message: string) => void = () => {}): Promise<string> {
  if (envToken) { registerSecrets([envToken]); return envToken; }
  const file = path.join(dataDir, 'obs-token');
  const read = async () => {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 16384) throw new Error('观测口令文件无效');
    const token = (await fs.readFile(file, 'utf8')).trim();
    if (!token) throw new Error('观测口令文件为空');
    await fs.chmod(file, 0o600);
    registerSecrets([token]);
    return token;
  };
  try { return await read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.mkdir(dataDir, { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, randomBytes(32).toString('base64url') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { await fs.link(temp, file); generated('observability token generated at /data/obs-token'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return await read();
  } finally { await fs.unlink(temp).catch(() => undefined); }
}

/** 健康探针仅发布布尔状态、计数和线程 ID，不透出服务地址、错误正文或配置。 */
export function publicHealth(input: { connected: boolean; degraded: boolean; comfy?: unknown; codex?: unknown; threads?: unknown; pi?: unknown }) {
  const ok = (value: unknown) => !!value && typeof value === 'object' && 'ok' in value && value.ok === true;
  return { ok: input.connected, ws_connected: input.connected, degraded: input.degraded,
    comfy: { ok: ok(input.comfy) }, codex: { ok: ok(input.codex), threads: input.threads }, pi: input.pi };
}
