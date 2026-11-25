import type { Observation, PiSpan, TraceSummary } from "../src/requests/execution-contracts";
export type TreeNode = {
  id: string;
  parent?: string;
  title: string;
  kind: string;
  start: number;
  end: number | null;
  row?: Observation;
};
export function executionNodes(rows: Observation[]) {
  const nodes = new Map<string, TreeNode>(),
    calls = new Map<string, string>();
  const group = (r: Observation) => JSON.stringify([r.actor, r.turn]);
  const call = (r: Observation, id: string) => JSON.stringify([r.actor, r.turn, id]);
  for (const r of rows) {
    if (r.kind === "tool") calls.set(call(r, r.callId), "tool/" + r.id);
    if (r.kind === "model") for (const id of r.calls) calls.set("model/" + call(r, id), "model/" + r.id);
  }
  const inputs = new Map(
    rows.filter((r) => r.actor !== "thread").map((r) => ["subagent-report:" + r.actor + ":" + r.inputId, group(r)]),
  );
  for (const r of rows) {
    const g = group(r),
      exists = nodes.get(g);
    const parent = r.dispatch ? (inputs.get(r.inputId) ?? "tool/" + r.dispatch) : undefined;
    if (exists) {
      exists.start = Math.min(exists.start, r.started);
      exists.end = exists.end === null || r.ended === null ? null : Math.max(exists.end, r.ended);
      if (parent) exists.parent = parent;
    } else
      nodes.set(g, {
        id: g,
        parent,
        title:
          r.actor === "thread" ? (r.dispatch ? "主 agent · 报告回合" : "主 agent") : "子 agent · " + r.actor.slice(0, 8),
        kind: "agent",
        start: r.started,
        end: r.ended,
        row: r,
      });
    const p = r.kind === "tool" ? (calls.get(call(r, r.parentCall)) ?? calls.get("model/" + call(r, r.callId))) : undefined;
    const id = r.kind + "/" + r.id;
    nodes.set(id, {
      id,
      parent: p ?? g,
      title: r.kind === "turn" ? "回合结算 · " + r.label : r.label,
      kind: r.kind,
      start: r.started,
      end: r.ended,
      row: r,
    });
  }
  return nodes;
}

// OTLP/HTTP JSON uses hexadecimal identifiers, numeric enums and decimal strings for int64.
async function identifier(parts: string[], length: number) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(hash).slice(0, length), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function attributes(values: Record<string, string | number | boolean | null | undefined>) {
  return Object.entries(values).flatMap(([key, v]) =>
    v == null
      ? []
      : [
          {
            key,
            value:
              typeof v === "string"
                ? { stringValue: v }
                : typeof v === "boolean"
                  ? { boolValue: v }
                  : Number.isInteger(v)
                    ? { intValue: String(v) }
                    : { doubleValue: v },
          },
        ],
  );
}
export async function exportExecution(summary: TraceSummary, rows: Observation[], native: PiSpan[] = []) {
  const nodes = executionNodes(rows);
  const traceId = await identifier([summary.thread, summary.root], 16);
  const rootId = await identifier([traceId, "snapshot"], 8);
  const ids = new Map<string, string>();
  for (const node of nodes.values()) ids.set(node.id, await identifier([traceId, node.id], 8));
  const ns = (ms: number) => String(BigInt(Math.trunc(ms)) * 1000000n);
  const end = Math.max(summary.last, ...rows.map((r) => r.ended ?? r.started));
  const spans = [...nodes.values()].map((n) => {
    const r = n.row!,
      model = n.kind === "model";
    const op = n.kind === "agent" ? "invoke_agent" : model ? "chat" : n.kind === "tool" ? "execute_tool" : undefined;
    const separator = r.label.indexOf("/");
    return {
      traceId,
      spanId: ids.get(n.id),
      parentSpanId: (n.parent && ids.get(n.parent)) || rootId,
      name: (op ?? "turn") + " " + n.title,
      kind: model ? 3 : 1,
      startTimeUnixNano: ns(n.start),
      endTimeUnixNano: ns(n.end ?? end),
      flags: 1,
      status: {
        code:
          n.end === null || n.kind === "agent"
            ? 0
            : ["error", "failed", "interrupted"].includes(r.status)
              ? 2
              : r.status === "aborted"
                ? 0
                : 1,
      },
      attributes: attributes({
        "gen_ai.operation.name": op,
        "gen_ai.agent.name": n.kind === "agent" ? r.actor : undefined,
        "gen_ai.conversation.id": summary.thread,
        "gen_ai.tool.name": n.kind === "tool" ? r.label : undefined,
        "gen_ai.provider.name": model && separator >= 0 ? r.label.slice(0, separator) : undefined,
        "gen_ai.request.model": model ? r.label.slice(separator + 1) : undefined,
        "gen_ai.usage.input_tokens": model ? r.input : null,
        "gen_ai.usage.output_tokens": model ? r.output : null,
        "gen_ai.usage.cache_read.input_tokens": model ? r.cached : null,
        "gen_ai.usage.cache_creation.input_tokens": model ? r.written : null,
        "cs_agent.cost_usd": model ? r.cost : null,
        "cs_agent.first_event_ms": model ? r.firstEvent : null,
        "cs_agent.alarm_wait_ms": model ? r.alarmWait : null,
        "cs_agent.reasoning_tokens": model ? r.reasoning : null,
        "cs_agent.turn": r.turn,
        "cs_agent.actor": r.actor,
        "cs_agent.record_id": n.kind !== "agent" ? r.id : undefined,
        "cs_agent.open_at_snapshot": n.end === null,
        "gen_ai.tool.call.id": n.kind === "tool" ? r.callId : undefined,
        "cs_agent.queue_wait_ms": n.kind === "turn" ? r.timing?.queue : null,
        "cs_agent.delivery_wait_ms": n.kind === "turn" ? r.timing?.delivery : null,
        "cs_agent.first_visible_ms": n.kind === "turn" ? r.timing?.firstVisible : null,
        "cs_agent.status": n.kind !== "agent" ? r.status : undefined,
      }),
    };
  });
  const root = {
    traceId,
    spanId: rootId,
    name: "agent execution",
    kind: 1,
    flags: 1,
    startTimeUnixNano: ns(Math.min(summary.started, ...rows.map((r) => r.started))),
    endTimeUnixNano: ns(end),
    attributes: attributes({
      "gen_ai.conversation.id": summary.thread,
      "cs_agent.root": summary.root,
      "cs_agent.snapshot": true,
    }),
  };
  const inputs = new Map<string, string>();
  for (const n of nodes.values()) {
    if (n.kind === "agent" && n.row) inputs.set(JSON.stringify([n.row.actor, n.row.inputId]), ids.get(n.id)!);
  }
  const pi = native.map((s) => {
    const model = typeof s.attrs["request.id"] === "string" && ids.get("model/" + s.attrs["request.id"]);
    const anchor = model || inputs.get(JSON.stringify([s.actor, s.inputId])) || rootId;
    return {
      traceId: s.trace,
      spanId: s.id,
      ...(s.parent ? { parentSpanId: s.parent } : {}),
      name: s.name,
      kind: 1,
      startTimeUnixNano: ns(s.started),
      endTimeUnixNano: ns(s.ended),
      flags: 1,
      status: { code: s.status === "error" ? 2 : s.status === "ok" ? 1 : 0 },
      attributes: attributes({
        ...s.attrs,
        "cs_agent.actor": s.actor,
        "cs_agent.input_id": s.inputId,
        "cs_agent.omitted": s.omitted || undefined,
        "gen_ai.conversation.id": summary.thread,
      }),
      events: s.events.map((e) => ({ timeUnixNano: ns(e.at), name: e.name, attributes: attributes(e.attrs) })),
      links: [...s.links.map((l) => ({ traceId: l.trace, spanId: l.id })), { traceId, spanId: anchor }],
    };
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: attributes({ "service.name": "cs-agent" }) },
        scopeSpans: [
          { scope: { name: "cs-agent.execution" }, spans: [root, ...spans] },
          ...(pi.length ? [{ scope: { name: "pi.telemetry" }, spans: pi }] : []),
        ],
      },
    ],
  };
}
