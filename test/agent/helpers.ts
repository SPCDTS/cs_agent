import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const tmp = (prefix = "cs-test-") => mkdtempSync(path.join(os.tmpdir(), prefix));
