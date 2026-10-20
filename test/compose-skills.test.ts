import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("cs-agent 将同源 skills 目录只读挂载到 pi 与 codex/shared", () => {
  const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const agent = compose.slice(compose.indexOf("  cs-agent:"), compose.indexOf("  napcat:"));
  const mounts = [...agent.matchAll(/^      - (.+):ro\r?$/gm)].map(match => match[1]);
  expect(mounts).toContain("${SKILLS_DIR:-./data/skills}:/data/skills");
  expect(mounts).toContain("${SKILLS_DIR:-./data/skills}:/data/codex/skills/shared");
});
