import { test } from "node:test";
import assert from "node:assert/strict";
import { CHATGPT_HELPER } from "../src/admin/chatgpt-helper.ts";

const { runLogin } = await import("data:text/javascript;base64," + Buffer.from(CHATGPT_HELPER).toString("base64"));
test("本机助手先监听回调，再用精确 redirect_uri 交换令牌并提交云端，结束后关闭监听", async () => {
  const ticket = "a".repeat(43), calls = [];
  let redirectUri, callbackTask;
  await runLogin({
    origin: "https://agent.example", ticket,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/bridge/begin")) {
        redirectUri = "http://localhost:" + JSON.parse(options.body).port + "/auth/callback";
        return Response.json({ url: "https://auth.openai.com/oauth/authorize?state=test-state", redirectUri,
          state: "test-state", verifier: "test-verifier", clientId: "app_EMoamEEZ73f0CkXaXp7hrann" });
      }
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: "secret-access", refresh_token: "secret-refresh" });
      if (url.endsWith("/bridge/complete")) return Response.json({ email: "owner@example.test" });
      throw new Error("unexpected endpoint");
    },
    launch: async () => {
      assert.equal((await fetch(redirectUri + "?state=wrong&code=x")).status, 400);
      callbackTask = fetch(redirectUri + "?state=test-state&code=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann").then(r => r.text());
    },
  });
  assert.match(await callbackTask, /授权完成/);
  const tokenCall = calls.find(call => call.url.endsWith("/oauth/token"));
  assert.equal(tokenCall.options.body.get("redirect_uri"), redirectUri);
  assert.equal(tokenCall.options.body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(tokenCall.options.body.get("code_verifier"), "test-verifier");
  assert.equal(tokenCall.url, "https://auth.openai.com/oauth/token");
  assert.equal(tokenCall.options.body.has("resource"), false);
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer " + ticket);
  assert.equal(JSON.parse(calls.at(-1).options.body).tokens.access_token, "secret-access");
  await assert.rejects(fetch(redirectUri));
});
