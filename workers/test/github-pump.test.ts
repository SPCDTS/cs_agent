import { expect, it, vi } from "vitest";
import { ThreadDO } from "../src/thread";

// Exercise the real pump with a deterministic Harness boundary. No model/network
// timing can mask busy-queue admission or an unbounded idle retry.
function fixture(profile = "chat", busy = false) {
  const rows: { message_id: string; kind: string; reply_channel: string; when_busy: string | null }[] = [];
  const runtime = { recovered: true, profile, harness: { resume: vi.fn(), waitForIdle: vi.fn(() => new Promise<void>(() => {})) } };
  const claim = vi.fn(async (_key: string) => "wait");
  const admitted: string[] = [];
  const host = {
    runtimeStarted: false, idleWait: undefined as Promise<void> | undefined,
    serial: (work: () => Promise<void>) => work(),
    open: async () => runtime,
    database: { all: vi.fn(async () => rows.filter(row => row.when_busy === null)), run: vi.fn() },
    idle: vi.fn(async () => !busy),
    syncModel: vi.fn(), applyProfile: vi.fn(async (_runtime: unknown, value: string) => { runtime.profile = value; }),
    env: { EVENTS: { getByName: () => ({ claimGitHubRun: claim }) } },
    admit: vi.fn(async (_runtime: unknown, row: typeof rows[number]) => {
      admitted.push(row.message_id); row.when_busy = "followUp"; return {};
    }),
    track: vi.fn(), ctx: { waitUntil: vi.fn() }, requestPump: vi.fn(),
  };
  const add = (key: string, kind = "message", channel = "qq") => rows.push({ message_id: key, kind, reply_channel: channel, when_busy: null });
  const pump = (afterIdle = false) => (ThreadDO.prototype as unknown as { pump(afterIdle: boolean): Promise<void> }).pump.call(host, afterIdle);
  return { host, runtime, rows, claim, admitted, add, pump, setBusy: (value: boolean) => { busy = value; } };
}

it("scans beyond a deferred backlog without looping and retries stable IDs on a fresh pump", async () => {
  const f = fixture("event");
  for (let i = 0; i < 45; i++) f.add("evt_github_" + i, "event");
  f.add("owner-a"); f.add("owner-b");
  await f.pump();
  expect(f.admitted).toEqual(["owner-a", "owner-b"]);
  expect(f.claim).toHaveBeenCalledTimes(45);
  expect(f.rows.slice(0,45).every(row => row.when_busy === null)).toBe(true);
  f.claim.mockResolvedValue("start");
  await f.pump();
  expect(f.admitted.slice(2)).toEqual(Array.from({length:45},(_,i) => "evt_github_" + i));
  await f.pump();
  expect(f.admitted).toHaveLength(47);
});

it.each(["chat", "event"])("defers busy GitHub work before %s profile barriers and only arms one idle retry", async profile => {
  const f = fixture(profile, true);
  f.add("evt_github_busy", "event");
  f.add("owner-a"); f.add("owner-b");
  await f.pump();
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.admitted).toEqual(profile === "chat" ? ["owner-a", "owner-b"] : []);
  expect(f.rows[0]?.when_busy).toBeNull();
  expect(f.runtime.harness.waitForIdle).toHaveBeenCalledTimes(1);
  // A resolved idle wait can still see a retained failed-run inbox.
  f.host.idleWait = undefined;
  await f.pump(true);
  expect(f.runtime.harness.waitForIdle).toHaveBeenCalledTimes(1);
  f.setBusy(false); f.claim.mockResolvedValue("start");
  await f.pump();
  expect(f.admitted.filter(key => key === "evt_github_busy")).toHaveLength(1);
});

it("does not let skipping GitHub reorder ordinary input across a web barrier", async () => {
  const f = fixture("chat", true);
  f.add("evt_github_busy", "event");
  f.add("web-first", "message", "web");
  f.add("owner-later");
  await f.pump();
  expect(f.admitted).toEqual([]);
  expect(f.host.applyProfile).not.toHaveBeenCalled();
  expect(f.claim).not.toHaveBeenCalled();
});