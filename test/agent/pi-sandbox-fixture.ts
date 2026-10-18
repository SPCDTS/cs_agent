import { promises as fs } from "node:fs";
import path from "node:path";
import { codingEnvironment } from "../../src/agent/pi-tools/coding.js";
import { tmp } from "./helpers.js";

export async function sandboxRequirements(dir: string): Promise<string> {
  const file = path.join(dir, "requirements.toml");
  await fs.writeFile(file, `[permissions.filesystem]\ndeny_read = [\n${[
    "*.sqlite*", "obs-token", "codex/auth.json", "images", "media", "incoming", "tickets",
  ].map(p => JSON.stringify(path.join(dir, p))).join(",\n")}\n]\n`, "utf8");
  return file;
}

export async function sandboxFixture(key = "group:7", ticket = "ticket-7", dataDir = tmp("pi-sandbox-")) {
  const dir = await fs.realpath(dataDir);
  const requirementsFile = await sandboxRequirements(dir);
  const store = { mediaPathAllowed: (_access: unknown, _file: string) => false };
  const options = { dataDir: dir, key, request: { ticket, access: key === "owner" ? "all" : key }, store, requirementsFile };
  const env = await codingEnvironment(options);
  return { dir, requirementsFile, store, options, env };
}

export async function put(file: string, text = "private-content"): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
  return file;
}
