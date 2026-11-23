import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sha256Hex } from "./hash";
import type { RuntimeSnapshot } from "../sandbox/client";
import { relativeWorkPath } from "../sandbox/workspace";
import { FILE_MAX_BYTES, WORKSPACE_MAX_BYTES } from "../media/model";

export type SharedAccess = "owner" | "reader";
export type SharedEntry = { path: string; hash: string; size: number; mode: number };
export type SharedChange = { path: string; bytes?: Uint8Array; mode?: number };
const DIR = "directory";
const chunkSize = 256 * 1024;
const protectedFile = (path: string) => /^mcp\/[^/]+\/(?:headers|oauth)\.json$/.test(path);

export function sharedSnapshot(entries: SharedEntry[], access: SharedAccess): RuntimeSnapshot {
  const directories = new Set(access === "owner" ? ["skills", "mcp"] : ["skills"]);
  const files = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.hash === DIR) directories.add(entry.path);
    else {
      files.push({ path: entry.path, sha256: entry.hash, bytes: entry.size, mode: entry.mode, mime: "application/octet-stream" });
      totalBytes += entry.size;
    }
  }
  return { directories: [...directories].sort(), files, totalBytes };
}

// 唯一文件内容存储。分块使单文件可使用 /work 相同的 10 MiB 上限，目录扫描只读元数据。
export class CapabilityFiles {
  constructor(
    private readonly sql: SqlStorage,
    private readonly key?: string
  ) {}
  initialize() {
    this.sql
      .exec(`CREATE TABLE IF NOT EXISTS capability_files(path TEXT PRIMARY KEY,hash TEXT NOT NULL,size INTEGER NOT NULL,mode INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_versions(id INTEGER PRIMARY KEY,owner INTEGER NOT NULL,reader INTEGER NOT NULL);
      INSERT OR IGNORE INTO capability_versions VALUES(1,0,0);
      CREATE TRIGGER IF NOT EXISTS capability_added AFTER INSERT ON capability_files BEGIN
        UPDATE capability_versions SET owner=owner+1,reader=reader+(NEW.path NOT GLOB 'mcp/*' AND NEW.path<>'mcp') WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS capability_removed AFTER DELETE ON capability_files BEGIN
        UPDATE capability_versions SET owner=owner+1,reader=reader+(OLD.path NOT GLOB 'mcp/*' AND OLD.path<>'mcp') WHERE id=1;
      END;
      CREATE TABLE IF NOT EXISTS capability_commits(workspace TEXT PRIMARY KEY,epoch INTEGER NOT NULL,applied INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_chunks(path TEXT NOT NULL,n INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(path,n));`);
  }
  version(access: SharedAccess) {
    const column = access === "owner" ? "owner" : "reader";
    return (
      column +
      "-" +
      this.sql.exec<{ revision: string }>(`SELECT CAST(${column} AS TEXT) AS revision FROM capability_versions WHERE id=1`).one()
        .revision
    );
  }
  visibilityChanged() {
    this.sql.exec("UPDATE capability_versions SET reader=reader+1 WHERE id=1");
  }
  receipt(workspace: string) {
    return this.sql
      .exec<{ epoch: number; applied: number }>("SELECT epoch,applied FROM capability_commits WHERE workspace=?", workspace)
      .toArray()[0];
  }
  record(workspace: string, epoch: number, applied: boolean) {
    this.sql.exec("INSERT OR REPLACE INTO capability_commits VALUES(?,?,?)", workspace, epoch, Number(applied));
  }
  stat(path: string) {
    return this.sql.exec<SharedEntry>("SELECT * FROM capability_files WHERE path=?", path).toArray()[0];
  }
  entries(prefix = "") {
    return this.sql
      .exec<SharedEntry>("SELECT * FROM capability_files WHERE substr(path,1,length(?))=? ORDER BY path", prefix, prefix)
      .toArray();
  }
  json(path: string): unknown {
    const text = this.text(path);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("invalid_request");
    }
  }
  text(path: string) {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.read(path));
  }
  read(path: string): Uint8Array {
    const entry = this.stat(path);
    if (!entry || entry.hash === DIR) throw new Error(entry ? "is_directory" : "not_found");
    const bytes = Buffer.alloc(entry.size + (protectedFile(path) ? 28 : 0));
    let offset = 0;
    for (const row of this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM capability_chunks WHERE path=? ORDER BY n", path)) {
      bytes.set(new Uint8Array(row.data), offset);
      offset += row.data.byteLength;
    }
    if (offset !== bytes.length) throw new Error("blob_corrupt");
    if (!protectedFile(path)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(path));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const plain = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    return new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength);
  }
  private encryptionKey() {
    if (!this.key || !/^[a-f0-9]{64}$/i.test(this.key)) throw new Error("unconfigured");
    return Buffer.from(this.key, "hex");
  }
  private parents(path: string) {
    const parents = [];
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) parents.push(path.slice(0, at));
    this.sql.exec("INSERT OR IGNORE INTO capability_files SELECT value,?,0,493 FROM json_each(?)", DIR, JSON.stringify(parents));
  }
  put(path: string, content: string | Uint8Array, mode = 420) {
    relativeWorkPath(path);
    let bytes =
      typeof content === "string" ? Buffer.from(content) : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    if (bytes.length > FILE_MAX_BYTES) throw new Error("workspace_quota");
    const size = bytes.length,
      hash = sha256Hex(bytes);
    if (protectedFile(path)) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
      cipher.setAAD(Buffer.from(path));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      bytes = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    }
    this.parents(path);
    this.remove(path);
    this.sql.exec("INSERT INTO capability_files VALUES(?,?,?,?)", path, hash, size, mode);
    for (let i = 0; i < bytes.length; i += chunkSize)
      this.sql.exec("INSERT INTO capability_chunks VALUES(?,?,?)", path, i / chunkSize, bytes.subarray(i, i + chunkSize));
  }
  mkdir(path: string) {
    relativeWorkPath(path);
    this.parents(path);
    this.remove(path);
    this.sql.exec("INSERT INTO capability_files VALUES(?,?,0,493)", path, DIR);
  }
  remove(path: string) {
    this.sql.exec("DELETE FROM capability_chunks WHERE path=?", path);
    this.sql.exec("DELETE FROM capability_files WHERE path=?", path);
  }
  removeTree(prefix: string) {
    for (const file of this.entries(prefix + "/")) this.remove(file.path);
    this.remove(prefix);
  }
  checkQuota() {
    const { bytes, count, pathBytes } = this.sql
      .exec<{
        bytes: number;
        count: number;
        pathBytes: number;
      }>("SELECT coalesce(sum(size),0) AS bytes,count(*) AS count,coalesce(sum(length(cast(path as blob))),0) AS pathBytes FROM capability_files")
      .one();
    if (bytes > WORKSPACE_MAX_BYTES || count > 20000 || pathBytes > 4 * 1024 * 1024) throw new Error("workspace_quota");
    const conflict = this.sql
      .exec(
        `SELECT 1 FROM capability_files f WHERE f.hash<>'directory' AND EXISTS
      (SELECT 1 FROM capability_files child WHERE child.path>=f.path||'/' AND child.path<f.path||'0') LIMIT 1`
      )
      .toArray();
    if (conflict.length) throw new Error("path_denied");
  }
}
