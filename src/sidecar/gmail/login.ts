import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { GmailError, safeError } from "./errors.js";
import { exchangeCode, readDesktopClient, SCOPES, type DesktopClient } from "./oauth.js";
import { constantTimeEqual } from "./server.js";

export async function login(options: { clientFile: string; tokenFile: string; printUrl?: (url: string) => void; timeoutMs?: number }): Promise<void> {
  const client = await readDesktopClient(options.clientFile);
  await authorize({ ...options, client });
}

export async function authorize(options: { client: DesktopClient; tokenFile: string; printUrl?: (url: string) => void; timeoutMs?: number }): Promise<void> {
  const client = options.client;
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
  let redirectUri = "", exchanging = false;
  let complete!: () => void, fail!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  const server = createServer((req, res) => {
    const callback = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method !== "GET" || callback.pathname !== "/") { res.writeHead(404).end(); return; }
    if (!constantTimeEqual(callback.searchParams.get("state") ?? "", state)) { res.writeHead(400).end("授权状态不匹配，请返回原授权页面"); return; }
    if (exchanging) { res.writeHead(409).end("正在完成授权"); return; }
    exchanging = true;
    void (async () => {
      try {
        const code = callback.searchParams.get("code");
        if (!code || callback.searchParams.has("error")) throw new GmailError("auth_missing", "Google 授权未完成，请重新运行 npm run gmail:login");
        await exchangeCode({ client, code, verifier, redirectUri, tokenFile: options.tokenFile });
        res.end("<!doctype html><meta charset=utf-8><p>授权完成，可关闭</p>", complete);
      } catch (error) {
        res.writeHead(400).end("授权失败，请查看终端中的分类提示", () => fail(error));
      }
    })();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new GmailError("config", "无法启动 Gmail 授权回调");
    redirectUri = `http://localhost:${address.port}`;
    const url = new URL(client.auth_uri);
    url.search = new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", scope: SCOPES,
      access_type: "offline", prompt: "consent", include_granted_scopes: "false", state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    }).toString();
    timer = setTimeout(() => fail(new GmailError("auth_missing", "Gmail 授权等待超时，请重新运行 npm run gmail:login")), options.timeoutMs ?? 600_000);
    (options.printUrl ?? (value => { process.stdout.write(`请复制以下地址到浏览器完成授权：\n${value}\n`); }))(url.toString());
    await completion;
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  login({ clientFile: process.env.GMAIL_CLIENT_FILE ?? "secrets/gmail/client.json", tokenFile: process.env.GMAIL_TOKEN_FILE ?? "secrets/gmail/token.json" })
    .catch(error => { process.stderr.write(safeError(error).message + "\n"); process.exitCode = 1; });
}
