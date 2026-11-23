import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { RegistryDO } from "../src/registry";
import { input } from "./helpers";
import { scriptedModel } from "./events-helpers";
import { boundMaterial, outbound, parseMaterial } from "../src/credentials/material";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const group = "group:200000001", endpoint = "https://api.example.test/items";
const registry = () => env.REGISTRY.getByName("main");
const bytes = (s: string) => new TextEncoder().encode(s);

it("主人从已提交文件导入，群通过 Code Mode 使用同一引用，轮换与撤权对下次调用生效", async () => {
  const first = "fixture-old-session", second = "fixture-new-session";
  const sent: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe(endpoint + "?page=1");
    expect(init?.redirect).toBe("manual");
    sent.push(new Headers(init?.headers).get("cookie") ?? "");
    return Response.json({ count: sent.length }, { headers: { "Set-Cookie": "private=fixture-response-only" } });
  });
  const sandbox = env.SANDBOX.getByName("owner");
  const path = "/work/login/cookies.txt";
  await sandbox.saveAttachment(path, bytes("sid=" + first));
  const code = (code: string): Parameters<typeof scriptedModel>[0] => [{ name: "codemode", args: { code } }, { name: "", args: {} }];
  const query = `text(await tools.credential_request({ref:'shop',url:'${endpoint}?page=1'}))`;
  const seen = scriptedModel([
    ...code(`text(await tools.credential_import({ref:'shop',path:'${path}',binding:{kind:'cookie',endpoints:['${endpoint}']}}));
      text(await tools.credential_share({ref:'shop',group:'${group}',allow:true}));`),
    ...code("text(await describeNamespace('credentials'));text(await tools.credential_list({}));" + query),
    ...code(`const entry = (await tools.credential_list({})).credentials[0];text(await tools.credential_rotate({ref:entry.ref,expectedRevision:entry.revision,path:'${path}.new'}));`),
    ...code(query),
    ...code(`text(await tools.credential_share({ref:'shop',group:'${group}',allow:false}));`),
    ...code(query),
  ]);
  const ownerTurn = (n: number) => env.THREAD.getByName("owner").submit(input(n, "维护测试凭证", 10000001));
  const groupTurn = (n: number) => env.THREAD.getByName(group).submit(input(n, "运行测试查询", 10000004, 200000001, true));
  await ownerTurn(1);
  expect(await registry().sharedCredentialList(group), seen.outputs.join("\n")).toMatchObject([{ ref: "shop" }]);
  await groupTurn(2);
  expect(seen.outputs.at(-1)).toContain("count");
  expect(seen.outputs.at(-1)).not.toContain("credential_import");
  await sandbox.saveAttachment(path + ".new", bytes("sid=" + second));
  await ownerTurn(3);
  await groupTurn(4);
  await ownerTurn(5);
  await groupTurn(6);
  expect(seen.outputs.at(-1)).toContain("credential_denied");
  expect(sent).toEqual(["sid=" + first, "sid=" + second]);
  const transcript = seen.outputs.join("\n");
  for (const value of [first, second, "fixture-response-only"]) expect(transcript).not.toContain(value);
  await runInDurableObject(registry(), (_instance, state) => {
    const row = state.storage.sql.exec("SELECT * FROM shared_credentials").one();
    expect(row.encrypted).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(second);
  });
});

it("授权与目的地在出站前核对，重定向、回显和未经授权的响应不能取回，过期触发主人告警", async () => {
  const r = registry(), secret = "fixture-private-key";
  const { revision } = await r.sharedCredentialSave({ ref: "weather", binding: { kind: "api-key", endpoints: [endpoint] } }, bytes(secret));
  await r.sharedCredentialGrant("weather", group, true);
  await r.sharedCredentialGrant("weather", "group:12", true);
  await runInDurableObject(r, async instance => {
    if (!(instance instanceof RegistryDO)) throw new Error("expected RegistryDO");
    const pending = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      instance.sharedCredentialGrant("weather", "group:12", false);
      return Response.json({ privateResult: true });
    });
    try { await expect(instance.sharedCredentialRequest("group:12", "weather", endpoint, "qq")).rejects.toThrow("credential_denied"); }
    finally { pending.mockRestore(); }
  });
  const fetcher = vi.spyOn(globalThis, "fetch");
  for (const url of [endpoint.replace("api.", "another."), endpoint + "/other", endpoint.replace("https:", "http:")]) {
    await expect(Promise.resolve(r.sharedCredentialRequest(group, "weather", url, "qq"))).rejects.toThrow("credential_target_denied");
  }
  expect(await r.sharedCredentialList("group:42")).toEqual([]);
  await expect(Promise.resolve(r.sharedCredentialRequest("group:42", "weather", endpoint, "qq"))).rejects.toThrow("credential_denied");
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: "https://other.example.test" } }));
  await expect(Promise.resolve(r.sharedCredentialRequest(group, "weather", endpoint, "qq"))).rejects.toThrow("credential_redirect_denied");
  fetcher.mockImplementationOnce(async (_, init) => Response.json({ value: new Headers(init?.headers).get("X-API-Key") }));
  await expect(Promise.resolve(r.sharedCredentialRequest(group, "weather", endpoint, "qq"))).rejects.toThrow("credential_response_withheld");
  fetcher.mockImplementationOnce(async () => Response.json({ echo: "fixture-renewed-cookie" }, { headers: { "Set-Cookie": "sid=fixture-renewed-cookie; Secure" } }));
  await expect(Promise.resolve(r.sharedCredentialRequest(group, "weather", endpoint, "qq"))).rejects.toThrow("credential_response_withheld");
  fetcher.mockImplementationOnce(async () => new Response("a".repeat(65537)));
  await expect(Promise.resolve(r.sharedCredentialRequest(group, "weather", endpoint, "qq"))).rejects.toThrow("credential_request_failed");
  fetcher.mockImplementationOnce(async () => new Response(secret, { status: 401 }));
  await expect(Promise.resolve(r.sharedCredentialRequest(group, "weather", endpoint, "qq"))).rejects.toThrow("credential_login_required");
  expect(await r.alerts()).toMatchObject([{ kind: "credential_login", scope: "credential:weather", closedAt: null }]);
  await expect(Promise.resolve(r.sharedCredentialSave({ ref: "weather", expectedRevision: "stale" }, bytes("unused")))).rejects.toThrow("credential_conflict");
  const updated = await r.sharedCredentialSave({ ref: "weather", expectedRevision: revision }, bytes("fixture-updated-key"));
  expect((await r.alerts())[0]?.closedAt).toEqual(expect.any(Number));
  await r.sharedCredentialForget("weather", updated.revision);
  await r.sharedCredentialSave({ ref: "weather", binding: { kind: "bearer", endpoints: ["https://api.example.test/*"] } }, bytes("recreated"));
  expect(await r.sharedCredentialList(group)).toEqual([]);
  fetcher.mockImplementationOnce(async (_, init) => Response.json({ ok: new Headers(init?.headers).get("authorization") === "Bearer recreated" }));
  expect(await r.sharedCredentialRequest("owner", "weather", endpoint + "/42", "qq")).toMatchObject({ body: '{"ok":true}' });
  await expect(Promise.resolve(r.sharedCredentialRequest("owner", "weather", endpoint.replace("api.", "other.api."), "qq"))).rejects.toThrow("credential_target_denied");
});

it("curl 导出的 Cookie 保留 HttpOnly、域、路径和到期约束", () => {
  const jar = [
    "# Netscape HTTP Cookie File",
    "#HttpOnly_.example.test\tTRUE\t/items\tTRUE\t0\tsid\tfixture-sid",
    "example.test\tFALSE\t/\tTRUE\t0\thostonly\tfixture-other",
    "api.example.test\tFALSE\t/\tTRUE\t1\told\tfixture-expired",
    "api.example.test\tFALSE\t/\tTRUE\t0\troot\tfixture-root",
  ].join("\n");
  const material = parseMaterial(bytes(jar), "cookie");
  const policy = { kind: "cookie" as const, endpoints: [endpoint] };
  const selected = boundMaterial(bytes(jar), { ...policy, cookieNames: ["sid"] });
  expect(outbound(selected, policy, new URL(endpoint)).value).toBe("sid=fixture-sid");
  expect(outbound(material, policy, new URL(endpoint)).value).toBe("sid=fixture-sid; root=fixture-root");
  expect(outbound(material, policy, new URL(endpoint + "foo")).value).toBe("root=fixture-root");
  expect(() => outbound(material, policy, new URL("https://other.test/"))).toThrow("credential_cookie_scope");
});
