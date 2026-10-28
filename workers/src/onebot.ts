export type InboundInput = { messageId: string; userId: string; text: string; time: number };
export type SendReceipt = { message_id: string };
type Frame =
  | { kind: "meta"; selfId: string }
  | { kind: "message"; private: boolean; input: InboundInput }
  | { kind: "response"; echo: string; result: { ok: true; receipt: SendReceipt } | { ok: false } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): string {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? String(value) : "";
}

export function parseFrame(raw: string | ArrayBuffer): Frame | undefined {
  let value: unknown;
  try { value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
  catch { return undefined; }
  if (!isRecord(value)) return undefined;
  if (typeof value.echo === "string") {
    const messageId = isRecord(value.data) ? id(value.data.message_id) : "";
    return {
      kind: "response", echo: value.echo,
      result: value.status === "ok" && value.retcode === 0 && messageId !== ""
        ? { ok: true, receipt: { message_id: messageId } } : { ok: false },
    };
  }
  if (value.post_type === "meta_event") return { kind: "meta", selfId: id(value.self_id) };
  if (value.post_type !== "message") return undefined;
  const text = Array.isArray(value.message) ? value.message.flatMap((segment: unknown) =>
    isRecord(segment) && segment.type === "text" && isRecord(segment.data) && typeof segment.data.text === "string"
      ? [segment.data.text] : [],
  ).join("") : "";
  return {
    kind: "message", private: value.message_type === "private",
    input: { messageId: id(value.message_id), userId: id(value.user_id), text,
      time: typeof value.time === "number" && Number.isFinite(value.time) ? value.time : Math.floor(Date.now() / 1000) },
  };
}

export function channelDown(): Error {
  return Object.assign(new Error("channel_down"), { name: "channel_down" });
}
