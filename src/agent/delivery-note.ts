import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DeliveryNote, ThreadKey } from "./backends/types.js";

export function deliveryNoteText(fallback: string): string {
  return `[系统] 上一轮你的回答没有通过 send_message 发出，用户只收到了“${fallback}”。回复用户必须调用 send_message。`;
}

type PendingNote = DeliveryNote & { pending: boolean };
const queues = new Map<string, Promise<unknown>>();

/** 每个线程键一个原子文件；保留已消费票据号，避免 settle 重试重新注入。 */
export class CodexDeliveryNotes {
  constructor(private readonly dataDir: string) {}

  private file(key: ThreadKey): string {
    return path.join(this.dataDir, "codex-delivery-notes", createHash("sha256").update(key).digest("hex") + ".json");
  }

  private async read(file: string): Promise<PendingNote | undefined> {
    try { return JSON.parse(await fs.readFile(file, "utf8")) as PendingNote; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private async update(key: ThreadKey, change: (old: PendingNote | undefined) => PendingNote | undefined): Promise<void> {
    const file = this.file(key);
    const run = (queues.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const next = change(await this.read(file));
      if (!next) return;
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(next) + "\n", { encoding: "utf8", flag: "wx" });
        await fs.rename(tmp, file);
      } finally { await fs.unlink(tmp).catch(() => {}); }
    });
    queues.set(file, run);
    try { await run; } finally { if (queues.get(file) === run) queues.delete(file); }
  }

  record(note: DeliveryNote): Promise<void> {
    return this.update(note.threadKey, old => old?.ticket === note.ticket ? undefined : { ...note, pending: true });
  }

  async pending(key: ThreadKey): Promise<DeliveryNote | undefined> {
    await queues.get(this.file(key));
    const note = await this.read(this.file(key));
    return note?.pending ? note : undefined;
  }

  clear(note: DeliveryNote): Promise<void> {
    return this.update(note.threadKey, old => old?.ticket === note.ticket ? { ...old, pending: false } : undefined);
  }
}
