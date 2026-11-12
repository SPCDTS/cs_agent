import { GitHubAppError } from "./app";

// Static allowlist only: never log exception messages or OAuth inputs.
export const CONNECT_STAGES = [
  "configuration", "browser", "state_prepare", "state_lookup", "state_missing", "state_expired",
  "state_binding", "state_epoch", "capacity", "token_exchange", "user", "discover", "inspect",
  "app_jwt", "install_repo", "vault", "persist", "snapshot", "revoked", "rpc", "internal",
] as const;
export type ConnectStage = typeof CONNECT_STAGES[number];
export type ConnectMark = (stage: ConnectStage) => void;
export type ConnectOperation = "start" | "complete";
export type ConnectFailure = { ok: false; status: number; code: string; requestId: string };
export type ConnectResult<T> = { ok: true; value: T } | ConnectFailure;

function classify(error: unknown, stage: ConnectStage): { status: number; code: string } {
  // Local to the DO, never instanceof across RPC. Unknown errors stay 500.
  if (error instanceof GitHubAppError) {
    switch (error.code) {
      case "unconfigured": return { status: 503, code: "github_app_unconfigured" };
      case "capacity": return { status: 429, code: "github_app_capacity" };
      case "rate_limited": return { status: 429, code: "github_app_rate_limited" };
      case "unavailable": return { status: 502, code: "github_app_unavailable" };
      case "reauthorization_required": return { status: 400, code: "github_app_reauthorization_required" };
      case "identity_changed": return { status: 400, code: "github_app_identity_changed" };
      case "unauthorized":
        switch (stage) {
          case "state_missing": return { status: 400, code: "github_connect_state_missing" };
          case "state_expired": return { status: 400, code: "github_connect_state_expired" };
          case "state_binding": return { status: 400, code: "github_connect_state_binding" };
          case "state_epoch": return { status: 400, code: "github_connect_state_epoch" };
          default: return { status: 400, code: "github_app_unauthorized" };
        }
    }
  }
  return { status: 500, code: "internal" };
}
export async function diagnoseConnect<T>(requestId: string, operation: ConnectOperation,
  work: (mark: ConnectMark) => Promise<T>): Promise<ConnectResult<T>> {
  const safeId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)
    ? requestId : crypto.randomUUID();
  let stage: ConnectStage = "internal";
  const mark: ConnectMark = next => { stage = CONNECT_STAGES.includes(next) ? next : "internal"; };
  try { return { ok: true, value: await work(mark) }; }
  catch (error) {
    const failure = { ok: false as const, ...classify(error, stage), requestId: safeId };
    console.error({ event: "github_connect_failed", requestId: safeId,
      operation: operation === "start" ? "start" : "complete", stage, code: failure.code, status: failure.status });
    return failure;
  }
}
