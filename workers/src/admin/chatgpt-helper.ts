// 下载为 .mjs；不落盘保存令牌，只在本机收回调并通过 HTTPS 交给自己的云端。
export const CHATGPT_HELPER = String.raw`import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
function openBrowser(url) {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => reject(new Error("无法打开浏览器")));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function runLogin({ origin, ticket, fetchImpl = fetch, launch = openBrowser, timeoutMs = 600000 }) {
  const target = new URL(origin);
  if ((target.protocol !== "https:" && target.hostname !== "127.0.0.1") || target.username || target.password ||
    target.pathname !== "/" || target.search || target.hash || !/^[A-Za-z0-9_-]{43}$/.test(ticket))
    throw new Error("云端地址或配对码无效");
  origin = target.origin;
  async function post(path, value) {
    const response = await fetchImpl(origin + path, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + ticket },
      body: JSON.stringify(value), signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const code = typeof body.error === "string" && /^[a-z_]+$/.test(body.error) ? body.error : "request_failed";
      throw new Error("云端授权失败：" + code);
    }
    return response.json();
  }
  let pending, busy = false, finish, fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  // 在监听失败前也注册拒绝处理，避免启动阶段出现未处理的 Promise。
  completed.catch(() => {});
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    let callback;
    try { callback = new URL(request.url, pending?.redirectUri); } catch { response.writeHead(404).end(); return; }
    if (!pending || request.method !== "GET" || request.headers.host !== new URL(pending.redirectUri).host ||
      callback.pathname !== "/auth/callback" || callback.searchParams.get("state") !== pending.state || busy) {
      response.writeHead(400).end("无效回调"); return;
    }
    busy = true;
    try {
      if (callback.searchParams.has("error")) throw new Error("已取消 ChatGPT 授权");
      const clientId = callback.searchParams.get("client_id") || pending.clientId;
      const code = callback.searchParams.get("code");
      if (!code || clientId !== CLIENT_ID || (pending.clientId && clientId !== pending.clientId))
        throw new Error("授权回调不完整，请重新开始");
      const tokenResponse = await fetchImpl(TOKEN_URL, { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code,
          code_verifier: pending.verifier, redirect_uri: pending.redirectUri }),
        signal: AbortSignal.timeout(15000) });
      if (!tokenResponse.ok) { await tokenResponse.body?.cancel(); throw new Error("令牌交换失败，请重新授权"); }
      const tokens = await tokenResponse.json();
      const result = await post("/admin/model/oauth/codex/bridge/complete", { callbackUrl: callback.href, tokens });
      response.end(result.status === "catalog_pending"
        ? "ChatGPT 授权已保存，但云端模型目录暂不可用。无需重新登录；回到管理页刷新状态，选择该 Codex 账号并点击「使用所选账号」重试。"
        : "ChatGPT 授权完成。可以关闭此页，回到管理页刷新状态。");
      finish(result);
    } catch (error) {
      response.writeHead(400).end("授权未完成，请回到管理页重新开始。");
      fail(error);
    }
  });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(1455, "127.0.0.1", resolve);
    });
    timer = setTimeout(() => fail(new Error("授权已超时，请重新开始")), timeoutMs);
    pending = await post("/admin/model/oauth/codex/bridge/begin", { port: server.address().port });
    const authorize = new URL(pending.url);
    if (authorize.origin !== "https://auth.openai.com" || authorize.pathname !== "/oauth/authorize" || pending.clientId !== CLIENT_ID ||
      pending.redirectUri !== "http://localhost:1455/auth/callback")
      throw new Error("云端返回的授权地址无效");
    await launch(pending.url);
    return await completed;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ticket = (await terminal.question("粘贴管理页的配对码：")).trim();
    terminal.close();
    console.log("正在打开 ChatGPT 授权页面，完成后本助手会自动退出。");
    const result = await runLogin({ origin: process.argv[2], ticket });
    console.log(result.status === "catalog_pending" ? "授权已保存，模型目录暂不可用。请回管理页选择该账号重试，无需重新登录。" : "授权完成。请回到管理页刷新状态。");
  } catch {
    // 错误正文可能包含上游请求信息，不打印异常对象或令牌。
    console.error("授权未完成。请确认配对码在 10 分钟内有效、本机端口 1455 空闲，并在管理页重新开始。");
    process.exitCode = 1;
  } finally { terminal.close(); }
}
`;
