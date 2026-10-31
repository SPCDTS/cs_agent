import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_MAX_BYTES, sha256 } from "../src/media/model";
import { MediaRepository, readMediaToken } from "../src/media/repository";
import { downloadMedia, publicAddress } from "../src/media/download";
import { handleMediaRequest } from "../src/media/routes";
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const png = new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]);

describe("私有媒体资产", () => {
  it("二进制按scope隔离且内容校验，票据只授权单个对象并按期失效", async () => {
    const owner = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
    const asset = await owner.put({ bytes: png, name: "图片.png", kind: "image" });
    expect(asset).toMatchObject({ scope: "owner", mime: "image/png", bytes: png.length, sha256: await sha256(png) });
    expect((await owner.get(asset.id)).bytes).toEqual(png);
    await expect(new MediaRepository({ bucket: env.ASSETS, scope: "group:200000001" }).get(asset.id)).rejects.toThrow("asset_not_found");
    const issued = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(issued);
    const url = await owner.issueUrl(asset.id, "https://agent.example.com", 2);
    expect(url).not.toContain("owner");
    expect(url).not.toContain(asset.id);
    const token = new URL(url).searchParams.get("token") ?? "";
    expect((await readMediaToken(env.ASSETS, token)).bytes).toEqual(png);
    vi.spyOn(Date, "now").mockReturnValue(issued + 2001);
    await expect(readMediaToken(env.ASSETS, token)).rejects.toThrow("media_token_expired");
  });
  it("网页附件上传与下载要求管理员认证，对象票据下载不要求管理员口令", async () => {
    const deps = { bucket: env.ASSETS, authenticateAdmin: (request: Request) => request.headers.get("Authorization") === "Bearer admin-secret" };
    const upload = new Request("https://agent.example.com/media/assets/owner?name=result.bin", { method: "POST", body: png, headers: { Authorization: "Bearer admin-secret" } });
    const response = await handleMediaRequest(upload, deps);
    expect(response?.status).toBe(201);
    const asset = await response!.json<{ id: string }>();
    expect((await handleMediaRequest(new Request(`https://agent.example.com/media/assets/owner/${asset.id}`), deps))?.status).toBe(401);
    const good = await handleMediaRequest(new Request(`https://agent.example.com/media/assets/owner/${asset.id}`, { headers: { Authorization: "Bearer admin-secret" } }), deps);
    expect(new Uint8Array(await good!.arrayBuffer())).toEqual(png);
    const repo = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
    const publicResponse = await handleMediaRequest(new Request(await repo.issueUrl(asset.id, "https://agent.example.com")), deps);
    expect(publicResponse?.status).toBe(200);
    expect(publicResponse?.headers.get("Content-Disposition")).toContain("attachment;");
    expect(new Uint8Array(await publicResponse!.arrayBuffer())).toEqual(png);
  });
  it("拒绝超限与伪装成图片的文件", async () => {
    const repo = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
    await expect(repo.put({ bytes: new Uint8Array(FILE_MAX_BYTES + 1), name: "big" })).rejects.toThrow("too_large");
    await expect(repo.put({ bytes: new Uint8Array([1,2,3]), name: "fake.png", mime: "image/png", kind: "image" })).rejects.toThrow("unsupported_image");
  });
});
describe("有界公网下载", () => {
  it.each([200, 302])("默认DNS下载路径在Workers中支持图片入库，并拒绝DNS重定向（%s）", async status => {
    const image = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/mQAAAAASUVORK5CYII="), char => char.charCodeAt(0));
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      // 保留 Workers 原生 Request 校验，只替换外网响应，避免注入 resolve 绕过 DNS 路径。
      const request = new Request(input, init), url = new URL(request.url);
      requests.push(url.hostname);
      if (url.hostname === "cloudflare-dns.com") {
        if (status === 302) return new Response(null, { status, headers: { Location: "https://other.example.com/dns-query" } });
        return Response.json({ Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
      }
      if (url.href === "https://multimedia.nt.qq.com.cn/image.png") return new Response(image, { headers: { "Content-Type": "image/png" } });
      throw new Error("unexpected_media_request");
    });
    const repo = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
    const imported = repo.importRemote({ url: "https://multimedia.nt.qq.com.cn/image.png", kind: "image" });
    if (status === 302) {
      await expect(imported).rejects.toThrow("media_dns_failed");
      expect(requests).toEqual(["cloudflare-dns.com", "cloudflare-dns.com"]);
    } else {
      const asset = await imported;
      expect(asset).toMatchObject({ kind: "image", mime: "image/png", bytes: image.length });
      expect((await repo.get(asset.id)).bytes).toEqual(image);
      expect(requests).toEqual(["cloudflare-dns.com", "cloudflare-dns.com", "multimedia.nt.qq.com.cn"]);
    }
  });

  it("拒绝内网、混合DNS、保留地址和重定向到内网", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "192.168.0.2", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fd00::1", "2001:db8::1"]) expect(publicAddress(address), address).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/secret" } }));
    await expect(downloadMedia("https://cdn.example.com/a", { fetch: request, resolve: async () => ["1.1.1.1"] })).rejects.toThrow("media_url_denied");
    expect(request).toHaveBeenCalledTimes(1);
    await expect(downloadMedia("https://cdn.example.com/a", { fetch: request, resolve: async () => ["1.1.1.1", "10.0.0.1"] })).rejects.toThrow("media_url_denied");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("流式拒绝没有Content-Length的超限响应", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(FILE_MAX_BYTES + 1)));
    await expect(downloadMedia("https://cdn.example.com/a", { fetch: request, resolve: async () => ["1.1.1.1"] })).rejects.toThrow("too_large");
  });
});
