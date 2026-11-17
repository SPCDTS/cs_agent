import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { ShellSpec } from './device-shell.ts';

const strict = { additionalProperties: false };
export const Enrollment = Type.Object({ id: Type.String({ pattern: '^[a-f0-9-]{36}$' }), name: Type.String(), port: Type.Integer({ minimum: 1024, maximum: 65534 }),
  token: Type.String({ pattern: '^[a-f0-9]{64}$' }), tunnelToken: Type.String({ minLength: 20 }), desktopToken: Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()]) }, strict);
export const DeviceConfig = Type.Object({ version: Type.Literal(1), enrollment: Enrollment, workdir: Type.String(), shell: ShellSpec,
  cloudflared: Type.String(), desktop: Type.Union([Type.Object({ command: Type.String(), args: Type.Array(Type.String()) }, strict), Type.Null()]),
  pairing: Type.Union([Type.Object({ url: Type.String(), token: Type.String(), claim: Type.String() }, strict), Type.Null()]),
}, strict);
export type Config = Static<typeof DeviceConfig>;
export const statePath = () => path.join(os.homedir(), '.cs-agent-device');

export async function protectDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const run = promisify(execFile);
    const { stdout } = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new Error('device_account_unknown');
    await run('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
  } else await chmod(directory, 0o700);
}
export async function saveConfig(directory: string, config: Config) {
  if (!Check(DeviceConfig, config)) throw new Error('device_config_invalid');
  const file = path.join(directory, 'config.json'), temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}
export async function loadConfig(directory: string): Promise<Config> {
  const value: unknown = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'));
  if (!Check(DeviceConfig, value) || !path.isAbsolute(value.workdir) || !path.isAbsolute(value.cloudflared)) throw new Error('device_config_invalid');
  return value;
}
