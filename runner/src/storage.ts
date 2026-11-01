import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { parse } from "./protocol.ts";
import { atomicJson, exists, readJson, sha256 } from "./files.ts";

const OwnerSchema = Type.Object({ version: Type.Literal(1), deviceId: Type.String() }, { additionalProperties: false });
type Storage = { dataDir: string; state: string; deviceId: string; protectedPaths: string[] };
function contains(parent: string, child: string) { const relative = path.relative(parent, child); return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); }
async function noLinks(target: string): Promise<void> {
  const parent = path.dirname(target);
  if (parent !== target) await noLinks(parent);
  if (!await exists(target)) return;
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("storage_directory_required_no_links");
}
export async function prepareStorage(input: Storage): Promise<string> {
  const root = path.resolve(input.dataDir);
  if (root === path.parse(root).root) throw new Error("dedicated_data_directory_required");
  for (const protectedPath of [input.state, ...input.protectedPaths].map(value => path.resolve(value))) {
    if (contains(root, protectedPath) || contains(protectedPath, root)) throw new Error("storage_overlaps_private_directory");
  }
  await noLinks(root);
  await fs.mkdir(root, { recursive: true });
  const marker = path.join(root, ".cs-agent-storage.json");
  if (await exists(marker)) {
    if (parse(OwnerSchema, await readJson(marker)).deviceId !== input.deviceId) throw new Error("storage_owned_by_another_device");
  } else {
    if ((await fs.readdir(root)).length) throw new Error("new_storage_directory_must_be_empty");
    await atomicJson(marker, { version: 1, deviceId: input.deviceId });
  }
  return root;
}
export async function workspaceStorage(input: Storage & { workspace: string }): Promise<{ work: string; cache: string }> {
  const root = await prepareStorage(input), scope = sha256(input.workspace);
  const work = path.join(root, "projects", scope), cache = path.join(root, "cache", scope, "npm");
  for (const directory of [work, cache]) {
    await noLinks(directory); await fs.mkdir(directory, { recursive: true }); await noLinks(directory);
  }
  return { work, cache };
}
