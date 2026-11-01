import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { parse, OutcomeSchema, ExecResultSchema } from "../src/protocol.ts";
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
const StartedSchema = Type.Object({ jobId: Type.Optional(Type.String()), leaseId: Type.Optional(Type.String()) });
async function completed(id: string) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const response = parse(Type.Object({ phase: Type.String(), outcome: Type.Union([OutcomeSchema, Type.Null()]) }),
      JSON.parse((await request(base, admin, "/smoke/status?run=" + run + "&id=" + id)).toString("utf8")));
    if (response.phase === "completed" && response.outcome?.kind === "completed") return parse(ExecResultSchema, response.outcome.result);
    if (["unknown", "cancelled", "failed"].includes(response.phase)) throw new Error(JSON.stringify(response));
    await delay();
  }
  throw new Error("smoke_timeout");
}
let leaseId: string | undefined;
try {
  let firstId: string | undefined;
  for (let attempt = 0; attempt < 30 && !firstId; attempt++) {
    const response = parse(StartedSchema, JSON.parse((await request(base, admin, "/smoke/start?run=" + run, { method: "POST" })).toString("utf8")));
    firstId = response.jobId; leaseId = response.leaseId; if (!firstId) await delay();
  }
  assert.ok(firstId); assert.ok(leaseId);
  const first = await completed(firstId); assert.equal(first.code, 0);
  const next = parse(StartedSchema, JSON.parse((await request(base, admin, "/smoke/next?run=" + run + "&lease=" + leaseId, { method: "POST" })).toString("utf8")));
  assert.ok(next.jobId);
  const second = await completed(next.jobId); assert.equal(second.code, 0);
  assert.match(second.stdout, /guest persistence verified/);
  await request(base, admin, "/smoke/release?run=" + run + "&lease=" + leaseId, { method: "POST" });
  console.log(JSON.stringify({ passed: true, deviceId: device.deviceId, jobs: [firstId, next.jobId], leaseId, state, result: second.stdout }));
} finally {
  await connector.stop(); await running;
  await request(base, admin, "/admin/sandbox-devices/" + device.deviceId, { method: "DELETE" });
}
