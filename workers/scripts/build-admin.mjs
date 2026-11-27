import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const [result, css, htmlTemplate, landingJs, landingCss, landingTemplate, iconSvg, joulePng, pagination, macJoin, windowsJoin] = await Promise.all([
  build({
    absWorkingDir: fileURLToPath(root), entryPoints: ["browser/main.ts"], bundle: true,
    format: "iife", platform: "browser", target: "es2022", write: false,
    legalComments: "none", charset: "utf8", logLevel: "warning",
  }),
  build({
    absWorkingDir: fileURLToPath(root), entryPoints: ["browser/admin.css"], bundle: true,
    loader: { ".css": "css" }, minify: true, write: false,
    legalComments: "none", charset: "utf8", logLevel: "warning",
  }),
  readFile(new URL("browser/index.html", root), "utf8"),
  build({
    absWorkingDir: fileURLToPath(root), entryPoints: ["browser/landing.ts"], bundle: true,
    format: "iife", platform: "browser", target: "es2022", write: false,
    legalComments: "none", charset: "utf8", logLevel: "warning",
  }),
  build({
    absWorkingDir: fileURLToPath(root), entryPoints: ["browser/landing.css"], bundle: true,
    loader: { ".css": "css" }, minify: true, write: false,
    legalComments: "none", charset: "utf8", logLevel: "warning",
  }),
  readFile(new URL("browser/landing.html", root), "utf8"),
  readFile(new URL("browser/icon.svg", root), "utf8"),
  readFile(new URL("browser/joule.png", root)),
  readFile(new URL("src/admin/pagination.ts", root), "utf8"),
  readFile(new URL("device/join.sh", root), "utf8"),
  readFile(new URL("device/join.ps1", root), "utf8"),
]);
const pageSize = /export const ADMIN_PAGE_SIZE = (\d+);/.exec(pagination)?.[1];
if (!pageSize) throw new Error("ADMIN_PAGE_SIZE not found in src/admin/pagination.ts");
const cleanIconSvg = iconSvg.trim();
const joulePngBase64 = joulePng.toString("base64");
const pageHtml = htmlTemplate
  .replace("/*__ADMIN_CSS__*/", () => css.outputFiles[0].text.trim())
  .replace("__ADMIN_PAGE_SIZE__", pageSize);
const landingHtml = landingTemplate
  .replace("/*__LANDING_CSS__*/", () => landingCss.outputFiles[0].text.trim());
await mkdir(new URL("src/admin/", root), { recursive: true });
await writeFile(new URL("src/admin/app.generated.ts", root),
  "// 此文件由 scripts/build-admin.mjs 生成，请修改 browser/ 中的源文件。\nexport const ICON_SVG = " + JSON.stringify(cleanIconSvg) + ";\nexport const JOULE_PNG_BASE64 = " + JSON.stringify(joulePngBase64) + ";\nexport const LANDING_PAGE_HTML = " + JSON.stringify(landingHtml) + ";\nexport const LANDING_APP_JS = " + JSON.stringify(landingJs.outputFiles[0].text) + ";\nexport const ADMIN_PAGE_HTML = " + JSON.stringify(pageHtml) + ";\nexport const ADMIN_APP_JS = " + JSON.stringify(result.outputFiles[0].text) + ";\nexport const CUA_MAC_JOIN = " + JSON.stringify(macJoin) + ";\nexport const CUA_WINDOWS_JOIN = " + JSON.stringify(windowsJoin) + ";\n", "utf8");
