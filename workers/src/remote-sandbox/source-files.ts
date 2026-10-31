import { Buffer } from "node:buffer";
import { imageMime } from "../media/model";
import { scopePrefix } from "../media/repository";
import { parseManifest, type WorkspaceManager, type WorkspaceManifest, type WorkspaceOperation, type WorkspaceOperationResult, type WorkspaceRunResult } from "../sandbox/workspace";
import { hash } from "./fleet";
import { FILE_MAX_BYTES, ephemeralPath, relativePath, validateSnapshot } from "../../../runner/src/protocol";

type FileOperation = Exclude<WorkspaceOperation, { kind: "exec" }>;
type Proposal = { fingerprint: string; manifest: WorkspaceManifest; expectedRevision: string; result: WorkspaceOperationResult };
/** 远程模式的文件读写以 R2 为准；由 RemoteWorkspace 的队列串行化。 */
export class SourceFiles {
  constructor(private readonly deps: { bucket: R2Bucket; workspace: WorkspaceManager; storage: DurableObjectStorage }) {}
  private async commit(operationId: string, proposal: Proposal): Promise<WorkspaceRunResult> {
    const committed = await this.deps.workspace.importSnapshot({ manifest: proposal.manifest, expectedRevision: proposal.expectedRevision, operationId: "file:" + operationId });
    if (!committed.ok) throw new Error("workspace_conflict");
    return { status: "committed", persistence: "committed", revision: committed.manifest.revision, result: proposal.result };
  }
  async run(operationId: string, operation: FileOperation): Promise<WorkspaceRunResult> {
    const path = relativePath(operation.path); if (ephemeralPath(path)) throw new Error("path_denied");
    const receiptKey = "remote:file:" + await hash(operationId), fingerprint = await hash(JSON.stringify(operation));
    if (operation.kind !== "read") {
      const intent = await this.deps.storage.get<{ fingerprint: string; object: string }>(receiptKey);
      if (intent) {
        if (intent.fingerprint !== fingerprint) throw new Error("operation_conflict");
        const object = await this.deps.bucket.get(intent.object); if (!object) throw new Error("persistence_failed");
        return this.commit(operationId, await object.json<Proposal>());
      }
    }
    const current = await this.deps.workspace.files(), file = current.files.find(row => row.path === path);
    if (current.directories.includes(path)) throw new Error("is_directory");
    let result: WorkspaceOperationResult;
    if (operation.kind === "read") {
      if (!file) throw new Error("not_found");
      const bytes = (await this.deps.workspace.readBlob(path, current.revision)).bytes, mimeType = imageMime(bytes);
      if (mimeType) result = { kind: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
      else {
        if (bytes.includes(0)) throw new Error("binary_file");
        const lines = new TextDecoder().decode(bytes).split("\n"), start = (operation.offset ?? 1) - 1;
        if (!Number.isInteger(start) || start < 0 || (operation.limit !== undefined && (!Number.isInteger(operation.limit) || operation.limit < 1))) throw new Error("invalid_request");
        if (start >= lines.length) throw new Error("offset_out_of_range");
        const taken: string[] = []; let size = 0;
        for (let at = start; at < Math.min(lines.length, start + (operation.limit ?? 2000)) && taken.length < 2000; at++) {
          const bytes = new TextEncoder().encode(lines[at]!);
          if (size + bytes.length + 1 > 50000) { if (!taken.length) taken.push(new TextDecoder().decode(bytes.slice(0, 50000))); break; }
          taken.push(lines[at]!); size += bytes.length + 1;
        }
        result = { text: taken.join("\n"), startLine: start + 1, endLine: start + taken.length, totalLines: lines.length };
      }
      return { status: "committed", persistence: "committed", revision: current.revision, result };
    }
    let content: string;
    if (operation.kind === "write") { content = operation.text; result = { bytes: new TextEncoder().encode(content).length }; }
    else {
      if (!file) throw new Error("not_found");
      content = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode((await this.deps.workspace.readBlob(path, current.revision)).bytes);
      if (!operation.edits.length) throw new Error("invalid_request");
      const spans = operation.edits.map(edit => {
        if (!edit.oldText) throw new Error("invalid_request");
        const at = content.indexOf(edit.oldText);
        if (at < 0) throw new Error("edit_not_found");
        if (content.indexOf(edit.oldText, at + 1) >= 0) throw new Error("edit_ambiguous");
        return { at, end: at + edit.oldText.length, text: edit.newText };
      }).sort((a, b) => a.at - b.at);
      if (spans.some((span, i) => i > 0 && span.at < spans[i - 1]!.end)) throw new Error("edit_overlap");
      for (const span of [...spans].reverse()) content = content.slice(0, span.at) + span.text + content.slice(span.end);
      result = { replaced: spans.length };
    }
    const bytes = new TextEncoder().encode(content), sha = await hash(bytes);
    if (bytes.length > FILE_MAX_BYTES) throw new Error("workspace_quota");
    const files = [...current.files.filter(file => file.path !== path), { path, sha256: sha, bytes: bytes.length, mime: file?.mime ?? "text/plain", mode: file?.mode ?? 420 }];
    const parts = path.split("/"), directories = new Set(current.directories);
    for (let n = 1; n < parts.length; n++) directories.add(parts.slice(0, n).join("/"));
    const manifest = parseManifest({ ...current, files, directories: [...directories], totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) });
    validateSnapshot({ files: manifest.files, directories: manifest.directories, totalBytes: manifest.totalBytes });
    const prefix = await scopePrefix(current.workspace) + "/workspace";
    await this.deps.bucket.put(prefix + "/blobs/" + sha, bytes);
    const proposal: Proposal = { manifest, expectedRevision: current.revision, result, fingerprint }, object = prefix + "/file-intents/" + await hash(operationId);
    await this.deps.bucket.put(object, JSON.stringify(proposal));
    await this.deps.storage.put(receiptKey, { fingerprint, object });
    return this.commit(operationId, proposal);
  }
}
