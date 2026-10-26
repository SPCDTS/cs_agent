import { defineDoc } from "@earendil-works/pi-durable";
import { z } from "zod";

const delegationSchema = z.strictObject({
  principal: z.string().regex(/^[1-9][0-9]{0,19}$/),
  servers: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  wake: z.boolean(), scheduled: z.boolean(),
});
export type McpDelegation = z.infer<typeof delegationSchema>;

/** 与子会话同提交保存；独立于汇报身份，不能仅凭 owner 派出取得外部账号能力。 */
export const McpDelegationDoc = defineDoc<{ grant: McpDelegation | null }>({
  kind: "cs.pi.mcp.delegation", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ grant: null }),
});

export function readDelegation(value: unknown): McpDelegation | null {
  const parsed = delegationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** 续发任务只收紧；未获授权的任务进入上下文后，后续 owner 消息也不能重新提权。 */
export function narrowDelegation(current: unknown, next: McpDelegation | null): McpDelegation | null {
  const grant = readDelegation(current);
  if (!grant || !next || grant.principal !== next.principal) return null;
  const servers = Object.fromEntries(Object.entries(grant.servers).filter(([id, digest]) => next.servers[id] === digest));
  return Object.keys(servers).length ? { principal: grant.principal, servers,
    wake: grant.wake || next.wake, scheduled: grant.scheduled || next.scheduled } : null;
}
