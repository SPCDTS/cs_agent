import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Check } from 'typebox/value';
import { createDesktopServer } from './desktop-server.ts';
import { DesktopContextSchema, DesktopConfigSchema } from './desktop-config.ts';

async function main() {
  const file = process.argv[2];
  if (!file || process.platform !== 'win32') throw new Error('desktop_mcp_configuration_required');
  const settings: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!Check(DesktopConfigSchema, settings) || !path.isAbsolute(settings.command) || !path.isAbsolute(settings.cwd)) throw new Error('desktop_mcp_invalid_configuration');
  const execute = promisify(execFile);
  const service = createDesktopServer(settings, async () => {
    try {
      const { stdout } = await execute(path.join(path.dirname(file), 'DesktopContext.exe'), [settings.desktopSid], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
      const value: unknown = JSON.parse(stdout);
      if (!Check(DesktopContextSchema, value)) throw new Error('desktop_unavailable');
      return value.stamp;
    } catch { throw new Error('desktop_unavailable'); }
  });
  await new Promise<void>((resolve, reject) => { service.server.once('error', reject); service.server.listen(settings.port, settings.host, resolve); });
  const stop = () => { void service.close().finally(() => { process.exitCode = 0; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
void main().catch(error => { process.stderr.write(JSON.stringify({ event: 'desktop_start_failed', error: error instanceof Error ? error.message : 'unknown' }) + '\n'); process.exitCode = 1; });
