import { defineDoc } from "@earendil-works/pi-durable";

/** owner 管理的动作授权：send 主动发往别处，schedule 创建并管理自己的定时任务。 */
export type Grant = {
  user: string;
  caps: ("send" | "schedule")[];
  targets: string[];
  scopes?: string[];
  expires_at?: number;
  granted_by: string;
  created_at: number;
  updated_at: number;
};
export const GrantsDoc = defineDoc<Record<string, Grant>>({
  kind: "cs.grants", version: 1, scope: "session", initial: () => ({}),
});
