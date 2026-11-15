import type { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import type { Env } from '../env';
import { threadOpsSettings } from '../settings';
import { MemoryManager, type MemoryListQuery, type ProfileProposal } from './management';
import { MemoryStore, MemoryStoreError, type Profile } from './store';
import type { MemoryEditor } from './editor';
import type { MemoryRow } from './types';
import type { ExtractComplete } from './extractor';
import { parseImport } from './import';
import { importMemoryHistory } from './history-import';
import { runConsolidate } from '../maintenance/consolidate';
import { generateProfileProposal } from '../maintenance/profile-proposal';

export interface MemoryAdminHost {
  database: DurableObjectSqliteDatabase;
  storage: DurableObjectStorage;
  env: Pick<Env, 'REGISTRY'>;
  complete: ExtractComplete;
  prepare(namespace: string): Promise<void>;
  publish(): Promise<void>;
}

/** 管理记忆的业务事务；命名空间复核与展示发布由宿主提供。 */
export class MemoryAdmin {
  constructor(private readonly host: MemoryAdminHost) {}
  async store(namespace: string): Promise<MemoryStore> {
    await this.host.prepare(namespace);
    return new MemoryStore(this.host.database, namespace);
  }
  private async publish<T>(work: Promise<T>): Promise<T> {
    const result = await work;
    await this.host.publish();
    return result;
  }
  async importMemory(value: unknown): Promise<{ inserted: number; skipped: number }> {
    const data = parseImport(value);
    return this.publish((await this.store(data.ns)).import(data));
  }
  async saveMemory(ns: string, id: number | null, input: MemoryEditor, expectedVersion?: number) {
    return this.publish(new MemoryManager(await this.store(ns)).save(id,input,expectedVersion));
  }
  async memoryCandidates(ns: string) { return new MemoryManager(await this.store(ns)).candidates(); }
  async decideMemoryCandidate(ns: string,id: number,accept: boolean) {
    return this.publish(new MemoryManager(await this.store(ns)).decideCandidate(id,accept));
  }
  async memoryList(ns: string, query: MemoryListQuery): ReturnType<MemoryManager["list"]> {
    return new MemoryManager(await this.store(ns)).list(query);
  }
  async memoryDetail(ns: string, id: number): ReturnType<MemoryManager["detail"]> {
    return new MemoryManager(await this.store(ns)).detail(id);
  }
  async restoreMemory(ns: string, id: number, options: { expectedVersion: number; versionId?: number }): ReturnType<MemoryManager["restore"]> {
    return this.publish(new MemoryManager(await this.store(ns)).restore(id, options));
  }
  async memoryJobs(ns: string): ReturnType<MemoryManager["jobs"]> {
    return new MemoryManager(await this.store(ns)).jobs();
  }
  async consolidateMemory(ns: string): ReturnType<typeof runConsolidate> {
    const store = await this.store(ns);
    const config = threadOpsSettings((await this.host.env.REGISTRY.getByName("main").opsSettings()).value, ns);
    return this.publish(runConsolidate({ db: this.host.database, kv: this.host.storage, store,
      complete: this.host.complete, config, now: Date.now() }));
  }
  async rollbackMemory(ns: string, batchId: string): ReturnType<MemoryManager["rollback"]> {
    return this.publish(new MemoryManager(await this.store(ns)).rollback(batchId));
  }
  async memoryProposals(ns: string, status: ProfileProposal["status"] | "all"): ReturnType<MemoryManager["proposals"]> {
    return new MemoryManager(await this.store(ns)).proposals(status);
  }
  async generateMemoryProposal(ns: string): ReturnType<typeof generateProfileProposal> {
    return this.publish(generateProfileProposal(await this.store(ns), this.host.complete, crypto.randomUUID(), true));
  }
  async decideMemoryProposal(ns: string, id: number, decision: "accepted" | "rejected", expectedRevision: string): ReturnType<MemoryManager["decideProposal"]> {
    return this.publish(new MemoryManager(await this.store(ns)).decideProposal(id, decision, expectedRevision));
  }
  async importMemoryHistory(ns: string, data: unknown, options: { dryRun?: boolean }): ReturnType<typeof importMemoryHistory> {
    return this.publish(importMemoryHistory(await this.store(ns), data, options));
  }

  async memoryView(ns: string, query: string): Promise<{ profile: Profile; memories: MemoryRow[] }> {
    const store = await this.store(ns), q = query.trim(), id = /^#(\d{1,15})$/.exec(q);
    const memories = id ? [await store.get(Number(id[1]))].filter(row => row !== undefined)
      : q ? await store.search({ query: q, limit: 20 }) : await store.recent(50);
    return { profile: await store.profile(), memories };
  }

  async forgetMemory(ns: string, id: number, expectedVersion?: number): Promise<{ status: "forgotten" | "not_found" }> {
    const store = await this.store(ns);
    if (!await store.get(id)) return { status: "not_found" };
    await store.forget(id, "admin", "面板遗忘", expectedVersion);
    await this.host.publish();
    return { status: "forgotten" };
  }

  async writeProfile(ns: string, text: string, expected: string): Promise<{ status: "ok" | "conflict"; current: Profile } | { status: "invalid"; reason: string }> {
    const store = await this.store(ns);
    try {
      const result = await store.writeProfile(text, expected);
      await this.host.publish();
      return { status: result.ok ? "ok" : "conflict", current: result.current };
    } catch (error) {
      if (error instanceof MemoryStoreError) return { status: "invalid", reason: error.message };
      throw error;
    }
  }

}
