import { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { createOneBotClient } from "../../src/qq/onebot.js";
import { FakeOneBot, SELF_ID, TOKEN } from "./fake-onebot.js";

it("skips Fetch-blocked ephemeral ports before exposing the HTTP server", async () => {
  const bot = new FakeOneBot();
  const rejected: Server[] = [];
  const address = Server.prototype.address;
  const spy = vi.spyOn(Server.prototype, "address");
  // 只替换系统返回的候选端口，真实监听仍使用 port=0，不占用固定端口。
  for (const port of [6000, 10080]) {
    spy.mockImplementationOnce(function (this: Server) {
      expect(rejected.every(server => server.listening)).toBe(true);
      rejected.push(this);
      return { ...(address.call(this) as AddressInfo), port };
    });
  }
  let started = false;
  try {
    await bot.start();
    started = true;
    spy.mockRestore();
    expect(rejected).toHaveLength(2);
    expect(rejected.every(server => !server.listening)).toBe(true);
    expect(bot.calls).toHaveLength(0);
    const client = createOneBotClient(bot.httpUrl, TOKEN, 2000);
    await expect(client.call("get_login_info")).resolves.toMatchObject({ user_id: Number(SELF_ID) });
    await expect(client.call("send_group_msg", { group_id: 30001 })).resolves.toMatchObject({ message_id: 5000 });
    await expect(client.call("send_private_msg", { user_id: 20001 })).resolves.toMatchObject({ message_id: 5001 });
  } finally {
    spy.mockRestore();
    if (started) await bot.stop();
    for (const server of rejected) {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
