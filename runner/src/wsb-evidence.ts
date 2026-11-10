import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { readJson } from "./files.ts";
import { Uuid } from "./wsb-native.ts";

const Stamp = Type.Integer({ minimum: 0 });
export const MAX_WSB_RESULT_BYTES = 196608;
export const SessionIntent = Type.Object({
  nativeId: Uuid, deadline: Stamp, memoryMb: Type.Integer({ minimum: 2048, maximum: 65536 }),
});
export const StartClaim = Type.Union([Type.Literal("helper"), Type.Literal("abandoned")]);
export const StartReceipt = Type.Union([Type.Literal("started"), Type.Literal("not-started")]);
export const Marker = Type.Literal(true);
export const JobRequest = Type.Object({ deadline: Stamp, preparedAt: Stamp });
export const GuestInput = Type.Object({
  id: Uuid, script: Type.String(), cwd: Type.Optional(Type.String()), deadline: Stamp,
});
const ShellResult = Type.Object({
  exitCode: Type.Integer(), stdout: Type.String({ maxLength: 65536 }),
  stderr: Type.String({ maxLength: 65536 }), truncated: Type.Boolean(),
}, { additionalProperties: false });
export const GuestResult = Type.Object({ id: Uuid, result: ShellResult }, { additionalProperties: false });
export const Heartbeat = Stamp;
export const JobReceipt = Type.Union([
  Type.Object({ state: Type.Literal("succeeded"), result: ShellResult }),
  Type.Object({ state: Type.Literal("failed"), error: Type.String({ maxLength: 256 }) }),
  Type.Object({ state: Type.Literal("cancelled") }),
]);
export type JobReceipt = Static<typeof JobReceipt>;

export function wsbSessionDir(stateDir: string, sessionId: string): string {
  return path.join(stateDir, "wsb-v1", parse(Uuid, sessionId));
}

export function sessionFiles(dir: string) {
  return {
    runtime: path.join(dir, "runtime"), executions: path.join(dir, "executions"),
    intent: path.join(dir, "start.json"), startClaim: path.join(dir, "start.claim.json"),
    startReceipt: path.join(dir, "start.receipt.json"), guardianReady: path.join(dir, "guardian.ready.json"),
    closing: path.join(dir, "closing.json"), closed: path.join(dir, "closed.json"),
  };
}

export function executionFiles(dir: string, executionId: string) {
  const root = path.join(sessionFiles(dir).executions, parse(Uuid, executionId));
  const inputDir = path.join(root, "input");
  const outputDir = path.join(root, "output");
  return {
    root, inputDir, outputDir, input: path.join(inputDir, "job.json"), output: path.join(outputDir, "result.json"),
    request: path.join(root, "request.json"), claim: path.join(root, "helper.claim.json"),
    heartbeat: path.join(root, "heartbeat.json"), issue: path.join(root, "uncertain.json"),
    execIntent: path.join(root, "exec.intent.json"),
    receipt: path.join(root, "receipt.json"),
  };
}

export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Check(schema, value)) throw new Error("invalid_wsb_evidence");
  return value;
}

export async function evidence<T extends TSchema>(file: string, schema: T): Promise<Static<T> | undefined> {
  try {
    return parse(schema, await readJson(file, MAX_WSB_RESULT_BYTES + 1024));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Publish a flushed immutable record in one directory operation. Competing
// processes see a complete claim or receipt and only one can publish it.
export async function record(file: string, value: unknown): Promise<boolean> {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(value), { encoding: "utf8", flag: "wx", flush: true });
    await fs.link(temp, file);
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}
