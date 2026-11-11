import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Check } from 'typebox/value';
import { createDesktopMcpGuest } from './desktop-mcp-guest.ts';
import { DesktopContextSchema, DesktopMcpSettingsSchema } from './desktop-mcp-protocol.ts';

async function main() {
  const file = process.argv[2];
  if (!file || process.platform !== 'win32') throw new Error('desktop_mcp_configuration_required');
  const settings: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!Check(DesktopMcpSettingsSchema, settings) || !path.isAbsolute(settings.command) || !path.isAbsolute(settings.cwd)) throw new Error('desktop_mcp_invalid_configuration');
  const execute = promisify(execFile);
  const context = async () => {
    try {
      const { stdout } = await execute(path.join(path.dirname(file), 'DesktopContext.exe'), ['context', settings.desktopSid], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
      const value: unknown = JSON.parse(stdout);
      if (!Check(DesktopContextSchema, value)) throw new Error('desktop_unavailable');
      return value.stamp;
    } catch { throw new Error('desktop_unavailable'); }
  };
  const bridge = createDesktopMcpGuest(settings, context);
  await bridge.listen();
  const stop = () => { void bridge.close().finally(() => { process.exitCode = 0; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
void main().catch(() => { process.exitCode = 1; });
