import { env, reset } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { CODEX_BASE_URL } from "../src/codex-login";
import { MediaRepository } from "../src/media/repository";
import { generateImage } from "../src/tools/imagegen";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/mQAAAAASUVORK5CYII=";
const models = { getAuth: async () => ({ auth: { apiKey: "synthetic-codex", baseUrl: CODEX_BASE_URL, headers: { "chatgpt-account-id": "synthetic-account" } } }) };
it("编辑读取会话图片后直传 Codex，结果入库；跨会话引用在发请求前被拒绝", async () => {
  const repository = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
  const original = await repository.put({ bytes: Buffer.from(png, "base64"), name: "原图.png" });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(CODEX_BASE_URL + "/images/edits");
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-codex");
    expect(await request.json()).toMatchObject({ images: [{ image_url: "data:image/png;base64," + png }], background: "transparent" });
    return Response.json({ data: [{ b64_json: png }] });
  });
  const result = await generateImage({ prompt: "去掉背景", images: [original.id], background: "transparent" }, { models, repository, operationId: "edit-test" });
  expect((await repository.get(result.ref.id)).ref).toMatchObject({ mime: "image/png", scope: "owner" });
  await expect(generateImage({ prompt: "改图", images: [original.id] }, { models,
    repository: new MediaRepository({ bucket: env.ASSETS, scope: "group:200000001" }), operationId: "denied" })).rejects.toMatchObject({ code: "asset" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("额度错误不重试，不泄漏上游正文，并保留脱敏请求标识", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-upstream-detail", { status: 429, headers: { "x-request-id": "req-image-test" } }));
  await expect(generateImage({ prompt: "画猫" }, { models, repository: new MediaRepository({ bucket: env.ASSETS, scope: "owner" }), operationId: "limited" }))
    .rejects.toMatchObject({ code: "rate_limit", diagnostic: { status: 429, requestId: "req-image-test" } });
  expect(fetch).toHaveBeenCalledTimes(1);
});
