import { AsyncLocalStorage } from "node:async_hooks";
import type { SpanAttributes, TelemetryCarrier, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { Env } from "../env";
import { containsSecret } from "../memory/secrets";
import type { PiSpan } from "./execution-contracts";

// Only admission reads the host input. Pi persists the carrier for later task phases and alarm resumes.
const modelInvocation = new AsyncLocalStorage<string>();
export const withModelTrace = <T>(id: string, run: () => T) => modelInvocation.run(id, run);
const admission = new AsyncLocalStorage<string>();
export const withTraceInput = <T>(id: string, run: () => T) => admission.run(id, run);
const names = new Set(["pi.durable.submit", "pi.durable.phase", "pi.ai.request", "pi.ai.poll"]);
const fields = new Set([
  "phase",
  "kind",
  "task.id",
  "task.name",
  "attempt",
  "resumed",
  "outcome",
  "result",
  "submission.type",
  "submission.id",
  "status",
  "tool",
  "tool.name",
  "tool.call_id",
  "type",
  "reason",
  "entry.kind",
  "entry.id",
  "provider",
  "model",
  "api",
  "stop",
  "reasoning",
  "usage.input",
  "usage.output",
  "usage.cache_read",
  "usage.cache_write",
  "cost.total",
  "chars",
  "index",
]);
type Identity = { trace: string; id: string; input: string };
const identity = new WeakMap<TelemetryContext, Identity>();
function safeAttributes(source?: SpanAttributes): PiSpan["attrs"] {
  const result: PiSpan["attrs"] = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (!fields.has(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) result[key] = value;
    if (typeof value === "string" && /^[\w./:=\-]{1,100}$/.test(value) && !containsSecret(value)) result[key] = value;
  }
  return result;
}
const random = () => crypto.randomUUID().replaceAll("-", "");
export function agentTelemetry(
  env: Env,
  ctx: Pick<DurableObjectState, "waitUntil">,
  thread: string,
  actor: string,
): TelemetryContext {
  const queue: PiSpan[] = [];
  let pending = false;
  let lost = 0;
  function collect(span: PiSpan) {
    if (queue.length >= 64) {
      lost++;
      return;
    }
    span.omitted += lost;
    lost = 0;
    queue.push(span);
    if (pending) return;
    pending = true;
    ctx.waitUntil(
      (async () => {
        // Let adjacent end events coalesce, with no recurring timer keeping a dormant agent awake.
        await scheduler.wait(20);
        try {
          while (queue.length) {
            const batch = queue.splice(0, 8);
            try {
              await env.REQUESTS.getByName("pi-trace:" + thread).recordPiSpans(batch);
            } catch {
              lost += batch.length;
            }
          }
        } finally {
          pending = false;
        }
      })(),
    );
  }
  const propagation = {
    inject(context: TelemetryContext): TelemetryCarrier | undefined {
      const ref = identity.get(context);
      return ref ? { trace: ref.trace, id: ref.id, input: ref.input } : undefined;
    },
    extract(carrier?: TelemetryCarrier): TelemetryContext {
      if (!carrier || !/^[a-f0-9]{32}$/.test(carrier.trace ?? "") || !/^[a-f0-9]{16}$/.test(carrier.id ?? "")) return root;
      return contextFor({ trace: carrier.trace, id: carrier.id, input: (carrier.input ?? "").slice(0, 256) });
    },
  };
  function contextFor(parent?: Identity): TelemetryContext {
    const context: TelemetryContext = {
      propagation,
      async startSpan(options, run) {
        const ref = {
          trace: parent?.trace ?? random(),
          id: random().slice(-16),
          input: parent?.input ?? (options.name === "pi.durable.submit" ? admission.getStore() : undefined) ?? "",
        };
        const data: PiSpan = {
          id: ref.id,
          trace: ref.trace,
          parent: parent?.id ?? "",
          actor,
          inputId: ref.input,
          name: options.name,
          started: Date.now(),
          ended: 0,
          status: "ok",
          attrs: safeAttributes(options.attributes),
          events: [],
          links: [],
          omitted: 0,
        };
        const modelId = modelInvocation.getStore();
        if (modelId && (data.name === "pi.ai.request" || data.name === "pi.ai.poll")) data.attrs["request.id"] = modelId;
        const child: TelemetrySpan = {
          ...contextFor(ref),
          addLink(link) {
            const target = identity.get(link.context);
            if (target && data.links.length < 8) data.links.push({ trace: target.trace, id: target.id });
          },
          setStatus(status) {
            data.status = status.status;
          },
          setAttributes(attrs) {
            Object.assign(data.attrs, safeAttributes(attrs));
          },
          addEvent(name, attrs) {
            if (!/^pi\.(ai|durable)\.[a-z._]{1,60}$/.test(name)) return;
            if (data.events.length >= 12) {
              data.omitted++;
              return;
            }
            data.events.push({ name, at: Date.now(), attrs: safeAttributes(attrs) });
          },
        };
        identity.set(child, ref);
        for (const link of options.links ?? []) child.addLink(link);
        try {
          return await run(child);
        } catch (error) {
          data.status = "error";
          throw error;
        } finally {
          data.ended = Date.now();
          if (names.has(data.name) && data.inputId) collect(data);
        }
      },
    };
    if (parent) identity.set(context, parent);
    return context;
  }
  const root = contextFor();
  return root;
}
