import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanOutgoing } from "../src/send-clean";
import { scriptedModel } from "./events-helpers";
import { action, connect, input, reply } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  vi.restoreAllMocks();
  await reset();
});

describe("cleanOutgoing", () => {
  it("turns Markdown links into plain text with the URL in full-width parentheses", () => {
    expect(cleanOutgoing("详见[官方文档](https://developers.cloudflare.com/workers/?utm_source=openai)。"))
      .toBe("详见官方文档（https://developers.cloudflare.com/workers/）。");
    expect(cleanOutgoing("[https://a.example/x](https://a.example/x?utm_source=openai)")).toBe("https://a.example/x");
  });

  it("drops utm_* parameters from bare and parenthesised URLs and keeps everything else", () => {
    expect(cleanOutgoing("来源 (https://a.example/p?id=1&utm_source=openai)")).toBe("来源 (https://a.example/p?id=1)");
    expect(cleanOutgoing("见 https://a.example/s?utm_source=openai&utm_medium=x#top，谢谢")).toBe("见 https://a.example/s#top，谢谢");
    expect(cleanOutgoing("搜 https://a.example/s?q=%E4%B8%AD+文&b=1 即可")).toBe("搜 https://a.example/s?q=%E4%B8%AD+文&b=1 即可");
    const plain = "[注意] 价格(含税)为 [100] 元；数组 a[0](1)";
    expect(cleanOutgoing(plain)).toBe(plain);
  });

  it("returns citation errors to the model and sends only its corrected QQ reply", async () => {
    const { socket, frames } = await connect(sockets);
    const seen = scriptedModel([
      { name: "send_message", args: { text: "见资料。\uE200cite\uE202turn1search0\uE201" } },
      { name: "send_message", args: { text: "见资料。\uE200cite\uE202turn1search2\uE202turn1search7\uE201" } },
      { name: "send_message", args: { text: "看[这里](https://a.example/d?utm_source=openai)" } },
    ]);
    const thread = env.THREAD.getByName("owner");
    const running = thread.submit(input(1, "请给出来源", 10000001));
    const frame = await action(frames, 0, "send_private_msg");
    reply(socket, frame.echo);
    expect(frame.params.message?.[0]?.data.text).toBe("看这里（https://a.example/d）");
    expect(await running).toEqual({ status: "done" });
    expect(seen.outputs).toEqual([
      expect.stringContaining("请改写 text 后重新调用 send_message"),
      expect.stringContaining("请改写 text 后重新调用 send_message"),
      expect.stringContaining('"status":"sent"'),
    ]);
    const intents = await runInDurableObject(thread, (_instance, state) =>
      state.storage.sql.exec("SELECT text FROM outgoing_intents").toArray());
    expect(intents).toEqual([{ text: "看这里（https://a.example/d）" }]);
  });
});
