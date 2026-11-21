import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { cleanOutgoing } from "../src/send-clean";
import { action, connect, input, reply } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
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

  it("strips hosted search PUA citation markers, preserves entity labels, and cleans adjacent URLs", () => {
    expect(cleanOutgoing("不是丢进JS运行时就能跑的服务。\uE200cite\uE202turn226540search0\uE201\n\n还要注意持久化。\uE200cite\uE202turn226540search2\uE202turn876495view0\uE201"))
      .toBe("不是丢进JS运行时就能跑的服务。\n\n还要注意持久化。");
    expect(cleanOutgoing("removed in v0.71.0 \uE200cite\uE202turn0view0\uE201. According to docs \uE200cite\uE202turn0search1\uE201 it works"))
      .toBe("removed in v0.71.0. According to docs it works");
    expect(cleanOutgoing("可用 \uE200entity\uE202[\"software\",\"Cloudflare Workers\",0]\uE201 部署，详见 https://developers.cloudflare.com/workers/?utm_source=openai\uE200cite\uE202turn0view0\uE201"))
      .toBe("可用 Cloudflare Workers 部署，详见 https://developers.cloudflare.com/workers/");
    expect(cleanOutgoing("截断尾部 \uE200cite\uE202turn99search")).toBe("截断尾部");
  });

  it("is applied to send_message before the text reaches NapCat", async () => {
    const { socket, frames } = await connect(sockets);
    // 测试配置的 faux 模型把输入原样回显成 send_message。
    const running = env.THREAD.getByName("owner").submit(input(1, "看[这里](https://a.example/d?utm_source=openai)\uE200cite\uE202turn1search0\uE201", 10000001));
    const frame = await action(frames, 0, "send_private_msg");
    expect(frame.params.message?.[0]?.data.text).toBe("echo: 看这里（https://a.example/d）");
    reply(socket, frame.echo);
    expect(await running).toEqual({ status: "done" });
  });
});
