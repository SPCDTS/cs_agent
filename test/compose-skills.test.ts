import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("cs-agent 将同源 skills 目录读写挂载到 pi 与 codex/shared", () => {
  const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const agent = compose.slice(compose.indexOf("  cs-agent:"), compose.indexOf("  napcat:"));
  const mounts = [...agent.matchAll(/^      - ([^\r\n]+)\r?$/gm)].map(match => match[1]);
  expect(mounts).toContain("${SKILLS_DIR:-./data/skills}:/data/skills");
  expect(mounts).toContain("${SKILLS_DIR:-./data/skills}:/data/codex/skills/shared");
  expect(mounts.filter(mount => mount.includes("${SKILLS_DIR")).some(mount => mount.endsWith(":ro"))).toBe(false);
});

it("cs-agent 容器时区默认 Asia/Shanghai，可用 TZ 覆盖", () => {
  const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const agent = compose.slice(compose.indexOf("  cs-agent:"), compose.indexOf("  napcat:"));
  expect(agent).toMatch(/^      TZ: \$\{TZ:-Asia\/Shanghai\}\r?$/m);
});
