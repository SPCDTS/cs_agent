import { pathToFileURL } from "node:url";
import { GmailError, safeError } from "./errors.js";
import { GmailClient } from "./gmail.js";
import { GmailOAuth, readDesktopClient } from "./oauth.js";
import { auditJson, createGmailHttp } from "./server.js";
import { SentStore } from "./store.js";

export async function main(): Promise<void> {
  const token = process.env.GMAIL_SIDECAR_TOKEN ?? "";
  if (token.length < 32 || /[^\x21-\x7e]/u.test(token)) throw new GmailError("config", "GMAIL_SIDECAR_TOKEN 必须为至少 32 字符的无空白 ASCII 随机串");
  const port = Number(process.env.GMAIL_SIDECAR_PORT ?? "3731");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GmailError("config", "GMAIL_SIDECAR_PORT 无效");
  const client = await readDesktopClient(process.env.GMAIL_CLIENT_FILE ?? "/secrets/gmail/client.json");
  const oauth = await GmailOAuth.open(client, process.env.GMAIL_TOKEN_FILE ?? "/secrets/gmail/token.json");
  const store = await SentStore.open(process.env.GMAIL_STATE_DIR ?? "/state");
  const server = createGmailHttp({ token, oauth, gmail: new GmailClient(oauth, store) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, process.env.GMAIL_SIDECAR_HOST ?? "0.0.0.0", () => { server.off("error", reject); resolve(); });
  });
  const shutdown = () => { server.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { auditJson({ status: "error", error: safeError(error).kind }); process.exitCode = 1; });
}
