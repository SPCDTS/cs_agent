import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const result = await build({
  absWorkingDir: fileURLToPath(root), entryPoints: ["browser/main.ts"], bundle: true,
  format: "iife", platform: "browser", target: "es2022", write: false,
  legalComments: "none", charset: "utf8", logLevel: "warning",
});
const device = await build({
  absWorkingDir: fileURLToPath(new URL('../runner/', root)), entryPoints: ['src/device-cli.ts'], bundle: true,
  format: 'cjs', platform: 'node', target: 'node24', minify: true, write: false,
  legalComments: 'none', charset: 'utf8', logLevel: 'warning',
});
await mkdir(new URL('src/devices/', root), { recursive: true });
await writeFile(new URL('src/devices/client.generated.ts', root),
  '// 自动生成的设备客户端；修改 runner/src/device-*.ts。\nexport const DEVICE_CLIENT = ' + JSON.stringify(device.outputFiles[0].text) + ';\n', 'utf8');
const schemas = await build({
  absWorkingDir: fileURLToPath(root), entryPoints: ["browser/contracts.ts"], bundle: true,
  format: "esm", platform: "node", target: "es2022", write: false, logLevel: "warning",
});
const contracts = await import("data:text/javascript;base64," + Buffer.from(schemas.outputFiles[0].text).toString("base64"));
await mkdir(new URL("src/admin/", root), { recursive: true });
await writeFile(new URL("src/admin/app.generated.ts", root),
  "// 此文件由 scripts/build-admin.mjs 生成，请修改 browser/ 中的源文件。\nexport const ADMIN_APP_JS = " + JSON.stringify(result.outputFiles[0].text) + ";\n" +
  "export const ADMIN_BROWSER_CONTRACTS = " + JSON.stringify(contracts) + ";\n", "utf8");
