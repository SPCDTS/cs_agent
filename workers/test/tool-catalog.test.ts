import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedModel } from "./events-helpers";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe("会话工具目录", () => {
  it.each([
    { thread: "owner", userId: 10000001, groupId: undefined },
    { thread: "group:200000001", userId: 10000004, groupId: 200000001 },
  ])("$thread 提供独立搜索与网页读取，不提供订阅生图", async ({ thread, userId, groupId }) => {
    const seen = scriptedModel([{ name: "", args: {} }]);
    expect(await env.THREAD.getByName(thread).submit(input(1, "读取指定网页", userId, groupId))).toEqual({ status: "done" });
    expect(seen.requests[0]!.tools).toContain("web_page");
    expect(seen.requests[0]!.tools).toContain("web_search");
    expect(seen.requests[0]!.tools).not.toContain("generate_image");
  });
});
