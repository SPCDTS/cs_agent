import type { Channel } from "../channel/types.js";
import type { SendRuleLimits } from "../channel/send-rules.js";

export interface QQBridgeConfig {
  /** 例如 http://host.docker.internal:3000 */
  httpUrl: string;
  /** 例如 ws://host.docker.internal:3001 */
  wsUrl: string;
  /** NapCat Bearer token，两个端点共用 */
  token: string;
  /** "*" 或 QQ 号列表；列表中的用户在任何会话均可触发 */
  allowUsers: string[] | "*";
  /** owner 账号始终允许入站，独立于 allowUsers。 */
  owners?: readonly string[];
  /** 群号列表；群内任何成员可通过真实 @机器人 触发 */
  allowGroups: string[];
  /** 为 false 时群消息一律不触发 */
  groupMentions: boolean;
  /** HTTP 调用超时，默认 15000；带图发送可放宽到 30000 */
  timeoutMs?: number;
  incomingDownloadConcurrency?: number;
  incomingDownloadDeadlineMs?: number;
  /** Inbox / Outbox / 去重状态持久化目录（SQLite 文件放在此处） */
  dataDir: string;
  /** 允许作为回复附件的图片根目录；路径必须 realpath 后落在其下 */
  imageRoot: string;
  /** 出站发送规则限额，每次发送前现读（面板可改）；缺省用 DEFAULT_SEND_RULES */
  sendRules?: () => SendRuleLimits;
}

/** QQ 通道的公开契约。 */
export type QQBridge = Channel;

export interface CreateQQBridge {
  (config: QQBridgeConfig): QQBridge;
}
