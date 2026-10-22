import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";

// setupFiles 已加载 test/setup-fetchable-ports.ts：listen(0) 分到 fetch 禁用端口时静默换端口。
it("listen(0) 跳过 fetch 禁用的端口：只发出一次 listening、不发出 close，最终端口可 fetch", async () => {
  const server = createServer((_req, res) => res.end("ok"));
  const address = Server.prototype.address;
  const spy = vi.spyOn(server, "address");
  for (const port of [6000, 10080]) spy.mockImplementationOnce(function (this: Server) { return { ...(address.call(this) as AddressInfo), port }; });
  let listening = 0, closed = 0;
  server.on("close", () => closed++);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => { listening++; resolve(); }));
    await new Promise(resolve => setImmediate(resolve));
    spy.mockRestore();
    expect([listening, closed]).toEqual([1, 0]);
    const port = (server.address() as AddressInfo).port;
    expect([6000, 10080]).not.toContain(port);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
  } finally {
    spy.mockRestore();
    await new Promise(resolve => server.close(resolve));
  }
  expect(closed).toBe(1);
});
