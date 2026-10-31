import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { parse } from "../src/protocol.ts";
import { Connector, request } from "../src/connector.ts";
import { descriptor, protectToken, type Config } from "../src/wsb.ts";
import { sha256 } from "../src/files.ts";
const base = "http://127.0.0.1:8797", admin = "synthetic-local-smoke-only", run = randomUUID();
const state = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-worker-smoke-"));
const seed = { name: "真实链路探针", nodeDir: path.dirname(process.execPath), memoryMiB: 4096, maxTimeoutMs: 1200000 };
const capabilities = await descriptor(seed), token = randomBytes(32).toString("hex");
const pairing = parse(Type.Object({ pairingId: Type.String(), code: Type.String() }),
  JSON.parse((await request(base, admin, "/admin/sandbox-devices/pairings", { method: "POST" })).toString("utf8")));
const device = parse(Type.Object({ deviceId: Type.String() }), JSON.parse((await request(base, undefined, "/sandbox-devices/claim", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pairingId: pairing.pairingId, code: pairing.code, tokenHash: sha256(token), descriptor: capabilities }),
})).toString("utf8")));
await request(base, admin, "/admin/sandbox-devices/" + device.deviceId + "/approve", { method: "POST" });
const config: Config = { ...seed, origin: base, deviceId: device.deviceId, tokenProtected: await protectToken(token) };
const connector = new Connector(state, config, fileURLToPath(new URL("../dist/", import.meta.url)));
const running = connector.run();
const delay = () => new Promise(resolve => setTimeout(resolve, 1000));
let id: string | undefined;
try {
  for (let attempt = 0; attempt < 30 && !id; attempt++) {
    const response = parse(Type.Object({ jobId: Type.Optional(Type.String()) }), JSON.parse((await request(base, admin, "/smoke/start?run=" + run, { method: "POST" })).toString("utf8")));
    id = response.jobId; if (!id) await delay();
  }
  assert.ok(id);
  let committed = false;
  for (let attempt = 0; attempt < 120 && !committed; attempt++) {
    const response = parse(Type.Object({ status: Type.Object({ phase: Type.String(), persistence: Type.Union([Type.String(), Type.Object({ state: Type.String() })]) }) }),
      JSON.parse((await request(base, admin, "/smoke/status?run=" + run + "&id=" + id)).toString("utf8")));
    const persistence = response.status.persistence;
    committed = typeof persistence !== "string" && persistence.state === "committed";
    if (response.status.phase === "unknown" || response.status.phase === "cancelled" || response.status.phase === "failed") throw new Error(JSON.stringify(response));
    if (!committed) await delay();
  }
  assert.ok(committed);
  assert.equal((await request(base, admin, "/smoke/result?run=" + run)).toString("utf8"), "Worker 到 WSB 再回 R2");
  await request(base, admin, "/smoke/release?run=" + run, { method: "POST" });
  console.log(JSON.stringify({ passed: true, deviceId: device.deviceId, jobId: id, state }));
} finally {
  await connector.stop(); await running;
  await request(base, admin, "/admin/sandbox-devices/" + device.deviceId, { method: "DELETE" });
}
