import { join } from "node:path";
import { z } from "zod";
import { GmailError } from "./errors.js";
import { atomicJson, isMissing, readJson } from "./files.js";

const receiptSchema = z.object({ messageId: z.string().min(1), threadId: z.string().min(1), at: z.number().finite() });
export type SentReceipt = z.infer<typeof receiptSchema>;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class SentStore {
  private records = new Map<string, SentReceipt>();
  private readonly unpersisted = new Map<string, SentReceipt>();
  private readonly pending = new Map<string, Promise<SentReceipt>>();
  private writing: Promise<void> = Promise.resolve();
  private constructor(private readonly file: string) {}

  static async open(directory: string): Promise<SentStore> {
    const store = new SentStore(join(directory, "sent.json"));
    try {
      const records = z.record(z.string(), receiptSchema).parse(await readJson(store.file));
      store.records = new Map(Object.entries(records));
      store.prune();
    } catch (error) {
      if (!isMissing(error)) throw new GmailError("storage", "Gmail 幂等记录无法读取，拒绝启动以避免重复发送");
    }
    return store;
  }

  async send(key: string, action: () => Promise<Omit<SentReceipt, "at">>): Promise<{ receipt: SentReceipt; duplicate: boolean }> {
    const pending = this.pending.get(key);
    if (pending) return { receipt: await pending, duplicate: true };
    this.prune();
    const previous = this.records.get(key);
    if (previous) return { receipt: previous, duplicate: true };
    const unpersisted = this.unpersisted.get(key);
    const operation = (async () => {
      const receipt = unpersisted ?? { ...await action(), at: Date.now() };
      // Gmail 已接收的邮件不能重发；写盘失败后保留回执，下一次只重试持久化。
      this.unpersisted.set(key, receipt);
      // 不同 key 的落盘也必须串行，快照在取得写锁后生成，避免旧快照覆盖新记录。
      const write = this.writing.then(async () => {
        await atomicJson(this.file, Object.fromEntries([...this.records, [key, receipt]]));
        this.records.set(key, receipt);
        this.unpersisted.delete(key);
      });
      this.writing = write.catch(() => {});
      await write;
      return receipt;
    })();
    this.pending.set(key, operation);
    try { return { receipt: await operation, duplicate: unpersisted !== undefined }; }
    finally { this.pending.delete(key); }
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [key, receipt] of this.records) if (receipt.at < cutoff) this.records.delete(key);
  }
}
