import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { sha256 } from "../media/model";
import { TokenVault } from "../mcp/crypto";
import { scopePrefix } from "../media/repository";
import type { RuntimeSnapshot, SandboxClient } from "../sandbox/client";
import { relativeWorkPath } from "../sandbox/workspace";
import {
  SKILL_MAX_OUTPUT_BYTES,
  SKILL_MAX_OUTPUT_FILES,
  SKILL_STATE_FILE_MAX_BYTES,
  SKILL_STATE_MAX_BYTES,
  SkillNameSchema,
} from "./manifest";

const SKILL_STATE_HEAD = "skill-state:head";
const SKILL_STATE_RECENT = "skill-state:recent";
const MAX_QUEUED_RUNS = 4;
const KEEP_MANIFESTS = 3;

const StateFileSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  bytes: Type.Integer({ minimum: 0, maximum: SKILL_STATE_FILE_MAX_BYTES }),
  mime: Type.String({ maxLength: 200 }),
  mode: Type.Integer({ minimum: 0, maximum: 511 }),
}, { additionalProperties: false });

const StateManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  skill: SkillNameSchema,
  revision: Type.String({ pattern: "^[a-f0-9-]{1,64}$" }),
  updatedAt: Type.Integer({ minimum: 0 }),
  files: Type.Array(StateFileSchema, { maxItems: 20000 }),
  directories: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 20000 }),
  totalBytes: Type.Integer({ minimum: 0, maximum: SKILL_STATE_MAX_BYTES }),
}, { additionalProperties: false });

export type SkillStateManifest = Static<typeof StateManifestSchema>;
export type SkillStateSummary = {
  skill: string;
  revision: string;
  updatedAt: number;
  totalBytes: number;
  fileCount: number;
  files: Array<{ path: string; bytes: number; mode: number }>;
};
export type SkillRunOutputFile = { path: string; bytes: number; data: Uint8Array };
export type SkillRunOutcome = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
  stateRevision: string;
  outputs: SkillRunOutputFile[];
};

export type SkillBashInput = {
  skill: string;
  revision: string;
  files: Record<string, string>;
  installNpmDeps: boolean;
  depsHash: string;
  command: string;
  timeoutMs: number;
};

type Deps = {
  workspaceId: string;
  bucket: R2Bucket;
  storage: DurableObjectStorage;
  vault: TokenVault;
  runtime: SandboxClient;
  runtimeReady(): boolean;
  resetRuntime(): Promise<unknown>;
};

const manifestIdentity = (skill: string, revision: string) => JSON.stringify(["skill-state-manifest", skill, revision]);
const blobIdentity = (skill: string, hash: string) => JSON.stringify(["skill-state-blob", skill, hash]);

function parseStateManifest(value: unknown, skill: string, revision: string): SkillStateManifest {
  if (!Check(StateManifestSchema, value) || value.skill !== skill || value.revision !== revision) {
    throw new Error("skill_state_corrupt");
  }
  const paths = new Set<string>();
  let total = 0;
  for (const file of value.files) {
    relativeWorkPath(file.path);
    if (paths.has(file.path)) throw new Error("skill_state_corrupt");
    paths.add(file.path);
    total += file.bytes;
  }
  for (const dir of value.directories) {
    relativeWorkPath(dir);
    if (paths.has(dir)) throw new Error("skill_state_corrupt");
    paths.add(dir);
  }
  const filePaths = new Set(value.files.map(file => file.path));
  for (const item of paths) {
    const parts = item.split("/");
    for (let end = 1; end < parts.length; end++) {
      if (filePaths.has(parts.slice(0, end).join("/"))) throw new Error("skill_state_corrupt");
    }
  }
  if (total !== value.totalBytes) throw new Error("skill_state_corrupt");
  return value;
}

/** 受控 Skill 独立加密状态管理：串行排队执行、R2 密文持久化、异常自动回滚。 */
export class SkillStateManager {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private hydrated = false;

  constructor(private readonly deps: Deps) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_QUEUED_RUNS) return Promise.reject(new Error("skill_busy"));
    this.pending++;
    const run = this.queue.then(work, work).finally(() => { this.pending--; });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async prefix(): Promise<string> {
    return `${await scopePrefix("skill-state:" + this.deps.workspaceId)}/skill-state`;
  }

  private emptyManifest(skill: string): SkillStateManifest {
    return { schemaVersion: 1, skill, revision: "0", updatedAt: 0, files: [], directories: [], totalBytes: 0 };
  }

  private async loadManifest(skill: string, revision?: string): Promise<SkillStateManifest> {
    if (!Check(SkillNameSchema, skill)) throw new Error("invalid_skill");
    const head = revision ?? (await this.deps.storage.get<string>(SKILL_STATE_HEAD)) ?? "0";
    if (head === "0") return this.emptyManifest(skill);
    if (!/^[a-f0-9-]{1,64}$/.test(head)) throw new Error("skill_state_corrupt");
    const object = await this.deps.bucket.get(`${await this.prefix()}/manifests/${head}`);
    if (!object) throw new Error("skill_state_corrupt");
    const decrypted = await this.deps.vault.decrypt(await object.text(), manifestIdentity(skill, head));
    return parseStateManifest(JSON.parse(decrypted), skill, head);
  }

  private async readDecryptedBlob(skill: string, file: SkillStateManifest["files"][number]): Promise<Uint8Array> {
    const object = await this.deps.bucket.get(`${await this.prefix()}/blobs/${file.sha256}`);
    if (!object) throw new Error("skill_state_corrupt");
    const plain = await this.deps.vault.decryptBytes(new Uint8Array(await object.arrayBuffer()), blobIdentity(skill, file.sha256));
    if (plain.byteLength !== file.bytes || await sha256(plain) !== file.sha256) throw new Error("skill_state_corrupt");
    return plain;
  }

  private async ensureRestored(skill: string): Promise<SkillStateManifest> {
    const manifest = await this.loadManifest(skill);
    if (this.hydrated && this.deps.runtimeReady()) return manifest;
    this.hydrated = false;
    await this.deps.resetRuntime();
    if (!this.deps.runtime.skillStateRestore) throw new Error("sandbox_unavailable");
    await this.deps.runtime.skillStateRestore(
      { files: manifest.files, directories: manifest.directories, totalBytes: manifest.totalBytes },
      file => this.readDecryptedBlob(skill, file),
    );
    this.hydrated = true;
    return manifest;
  }

  private async persistManifest(skill: string, next: SkillStateManifest): Promise<void> {
    const prefix = await this.prefix();
    const encryptedManifest = await this.deps.vault.encrypt(JSON.stringify(next), manifestIdentity(skill, next.revision));
    await this.deps.bucket.put(`${prefix}/manifests/${next.revision}`, encryptedManifest);
    const recent = (await this.deps.storage.get<string[]>(SKILL_STATE_RECENT)) ?? [];
    recent.push(next.revision);
    const evicted: string[] = [];
    while (recent.length > KEEP_MANIFESTS) {
      const old = recent.shift();
      if (old) evicted.push(old);
    }
    await this.deps.storage.put({ [SKILL_STATE_HEAD]: next.revision, [SKILL_STATE_RECENT]: recent });
    if (!evicted.length) return;

    const evictedHashes = new Set<string>();
    for (const old of evicted) {
      try {
        const oldManifest = await this.loadManifest(skill, old);
        for (const file of oldManifest.files) evictedHashes.add(file.sha256);
      } catch { /* 已被删除或损坏的旧清单不阻塞清理 */ }
    }
    if (evictedHashes.size) {
      const liveHashes = new Set(next.files.map(file => file.sha256));
      let liveLoaded = true;
      for (const rev of recent) {
        if (rev === next.revision) continue;
        try {
          const liveManifest = await this.loadManifest(skill, rev);
          for (const file of liveManifest.files) liveHashes.add(file.sha256);
        } catch {
          liveLoaded = false;
          break;
        }
      }
      if (liveLoaded) {
        for (const hash of evictedHashes) {
          if (!liveHashes.has(hash)) {
            await this.deps.bucket.delete(`${prefix}/blobs/${hash}`).catch(() => {});
          }
        }
      }
    }
    for (const old of evicted) {
      await this.deps.bucket.delete(`${prefix}/manifests/${old}`).catch(() => {});
    }
  }

  private async commitSnapshot(skill: string, previous: SkillStateManifest, snapshot: RuntimeSnapshot): Promise<SkillStateManifest> {
    if (snapshot.totalBytes > SKILL_STATE_MAX_BYTES) throw new Error("workspace_quota");
    if (JSON.stringify(snapshot.files) === JSON.stringify(previous.files)
      && JSON.stringify(snapshot.directories) === JSON.stringify(previous.directories)) {
      return previous;
    }
    const prefix = await this.prefix();
    const previousHashes = new Set(previous.files.map(file => file.sha256));
    for (const file of snapshot.files) {
      if (file.bytes > SKILL_STATE_FILE_MAX_BYTES) throw new Error("workspace_quota");
      if (previousHashes.has(file.sha256)) continue;
      const bytes = await this.deps.runtime.readBlob(`/work/state/${file.path}`);
      if (bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) throw new Error("blob_corrupt");
      const encrypted = await this.deps.vault.encryptBytes(bytes, blobIdentity(skill, file.sha256));
      await this.deps.bucket.put(`${prefix}/blobs/${file.sha256}`, encrypted);
      previousHashes.add(file.sha256);
    }
    const revision = crypto.randomUUID();
    const next = parseStateManifest({
      schemaVersion: 1,
      skill,
      revision,
      updatedAt: Date.now(),
      files: snapshot.files,
      directories: snapshot.directories,
      totalBytes: snapshot.totalBytes,
    }, skill, revision);
    await this.persistManifest(skill, next);
    return next;
  }

  private async executeInState(
    skill: string,
    code: { revision: string; files: Record<string, string>; installNpmDeps: boolean; depsHash: string },
    exec: () => Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; truncated: boolean; outputs: Array<{ path: string; bytes: number; sha256: string }> }>,
  ): Promise<SkillRunOutcome> {
    const previous = await this.ensureRestored(skill);
    if (!this.deps.runtime.materializeSkill || !this.deps.runtime.skillStateSnapshot
      || !this.deps.runtime.readSkillOutBlob || !this.deps.runtime.clearSkillOut) {
      throw new Error("sandbox_unavailable");
    }
    try {
      await this.deps.runtime.materializeSkill(code);
      const res = await exec();
      if (res.timedOut || res.code === null) {
        this.hydrated = false;
        await this.deps.resetRuntime().catch(() => {});
        return {
          stdout: res.stdout, stderr: res.stderr, code: res.code, timedOut: res.timedOut, truncated: res.truncated,
          stateRevision: previous.revision, outputs: [],
        };
      }
      if (res.outputs.length > SKILL_MAX_OUTPUT_FILES) throw new Error("output_limit");
      const outputs: SkillRunOutputFile[] = [];
      let totalOutputBytes = 0;
      for (const out of res.outputs) {
        const rel = relativeWorkPath(out.path);
        totalOutputBytes += out.bytes;
        if (out.bytes > SKILL_MAX_OUTPUT_BYTES || totalOutputBytes > SKILL_MAX_OUTPUT_BYTES) throw new Error("output_limit");
        const data = await this.deps.runtime.readSkillOutBlob(rel);
        if (data.byteLength !== out.bytes || await sha256(data) !== out.sha256) throw new Error("blob_corrupt");
        outputs.push({ path: rel, bytes: data.byteLength, data });
      }
      await this.deps.runtime.clearSkillOut();
      const snapshot = await this.deps.runtime.skillStateSnapshot();
      const next = await this.commitSnapshot(skill, previous, snapshot);
      return {
        stdout: res.stdout, stderr: res.stderr, code: res.code, timedOut: res.timedOut, truncated: res.truncated,
        stateRevision: next.revision, outputs,
      };
    } catch (error) {
      this.hydrated = false;
      await this.deps.resetRuntime().catch(() => {});
      throw error;
    }
  }

  runBash(input: SkillBashInput): Promise<SkillRunOutcome> {
    return this.serial(() => {
      if (!this.deps.runtime.execSkillBash) throw new Error("sandbox_unavailable");
      const execSkillBash = this.deps.runtime.execSkillBash.bind(this.deps.runtime);
      return this.executeInState(input.skill, input, () => execSkillBash({ command: input.command, timeoutMs: input.timeoutMs }));
    });
  }

  list(skill: string): Promise<SkillStateSummary> {
    return this.serial(async () => {
      const manifest = await this.loadManifest(skill);
      return {
        skill: manifest.skill,
        revision: manifest.revision,
        updatedAt: manifest.updatedAt,
        totalBytes: manifest.totalBytes,
        fileCount: manifest.files.length,
        files: manifest.files.map(file => ({ path: file.path, bytes: file.bytes, mode: file.mode })),
      };
    });
  }

  importFiles(input: { skill: string; files: Array<{ path: string; bytes: Uint8Array }> }): Promise<SkillStateSummary> {
    return this.serial(async () => {
      if (!input.files.length || input.files.length > 64) throw new Error("invalid_request");
      const current = await this.loadManifest(input.skill);
      const prefix = await this.prefix();
      const fileMap = new Map(current.files.map(file => [file.path, file]));
      const dirSet = new Set(current.directories);
      const seen = new Set<string>();
      const prepared: Array<{ rel: string; bytes: Uint8Array }> = [];
      let candidateTotal = current.totalBytes;
      for (const entry of input.files) {
        const rel = relativeWorkPath(entry.path);
        if (seen.has(rel)) throw new Error("invalid_request");
        if (dirSet.has(rel) || current.files.some(file => rel.startsWith(file.path + "/"))) throw new Error("workspace_conflict");
        seen.add(rel);
        if (!(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength > SKILL_STATE_FILE_MAX_BYTES) throw new Error("too_large");
        const parts = rel.split("/");
        for (let i = 1; i < parts.length; i++) {
          const ancestor = parts.slice(0, i).join("/");
          if (fileMap.has(ancestor) || seen.has(ancestor)) throw new Error("workspace_conflict");
          dirSet.add(ancestor);
        }
        for (const prior of seen) {
          if (prior !== rel && (prior.startsWith(rel + "/") || rel.startsWith(prior + "/"))) throw new Error("workspace_conflict");
        }
        const replaced = fileMap.get(rel);
        candidateTotal += entry.bytes.byteLength - (replaced?.bytes ?? 0);
        prepared.push({ rel, bytes: entry.bytes });
      }
      if (candidateTotal > SKILL_STATE_MAX_BYTES) throw new Error("workspace_quota");
      for (const { rel, bytes } of prepared) {
        const hash = await sha256(bytes);
        const encrypted = await this.deps.vault.encryptBytes(bytes, blobIdentity(input.skill, hash));
        await this.deps.bucket.put(`${prefix}/blobs/${hash}`, encrypted);
        fileMap.set(rel, { path: rel, sha256: hash, bytes: bytes.byteLength, mime: "application/octet-stream", mode: 0o600 });
      }
      const files = [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path));
      const directories = [...dirSet].sort();
      const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
      if (totalBytes > SKILL_STATE_MAX_BYTES) throw new Error("workspace_quota");
      const revision = crypto.randomUUID();
      const next = parseStateManifest({
        schemaVersion: 1,
        skill: input.skill,
        revision,
        updatedAt: Date.now(),
        files,
        directories,
        totalBytes,
      }, input.skill, revision);
      await this.persistManifest(input.skill, next);
      this.hydrated = false;
      if (this.deps.runtimeReady()) await this.deps.resetRuntime().catch(() => {});
      return {
        skill: next.skill,
        revision: next.revision,
        updatedAt: next.updatedAt,
        totalBytes: next.totalBytes,
        fileCount: next.files.length,
        files: next.files.map(file => ({ path: file.path, bytes: file.bytes, mode: file.mode })),
      };
    });
  }

  clear(skill: string): Promise<{ cleared: true }> {
    return this.serial(async () => {
      if (!Check(SkillNameSchema, skill)) throw new Error("invalid_skill");
      const prefix = `${await this.prefix()}/`;
      let cursor: string | undefined;
      do {
        const page = await this.deps.bucket.list({ prefix, cursor, limit: 500 });
        if (page.objects.length) await this.deps.bucket.delete(page.objects.map(object => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      await this.deps.storage.delete([SKILL_STATE_HEAD, SKILL_STATE_RECENT]);
      this.hydrated = false;
      if (this.deps.runtimeReady()) await this.deps.resetRuntime().catch(() => {});
      return { cleared: true };
    });
  }
}
