import { id, isRecord, normalizeMessage, normalizeNotice, type InboundInput, type InboundNotice } from "./policy";
export type { InboundInput } from "./policy";
export type SendReceipt = { message_id: string };
type Frame =
  | { kind: "meta"; selfId: string }
  | { kind: "message"; input: InboundInput }
  | { kind: "notice"; notice: InboundNotice }
  | { kind: "response"; echo: string; ok: boolean; data: unknown };

export function parseFrame(raw: string | ArrayBuffer): Frame | undefined {
  let value: unknown;
  try { value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
  catch { return; }
  if (!isRecord(value)) return;
  if (typeof value.echo === "string") return { kind: "response", echo: value.echo, ok: value.status === "ok" && value.retcode === 0, data: value.data };
  if (value.post_type === "meta_event") return { kind: "meta", selfId: id(value.self_id) };
  const notice = normalizeNotice(value);
  if (notice) return { kind: "notice", notice };
  const input = normalizeMessage(value);
  return input ? { kind: "message", input } : undefined;
}

export function channelDown(): Error {
  return Object.assign(new Error("channel_down"), { name: "channel_down" });
}
