import type { PendingImageJob } from "../../media/gen/image-pending.js";
import { defineDoc } from "@earendil-works/pi-durable";

/** 仅适配器写入身份；工具参数不能覆盖。计数按 taskId 去重，恢复不额外计次。 */
export const PiRequestDoc = defineDoc<{
  ticket: string;
  access: string;
  images: string[];
  content: string;
  deadline: number;
  imageJobs?: (PendingImageJob & { ordinal: number })[];
  calls: Record<string, { kind: string; ordinal: number }>;
}>({
  kind: "cs.pi.request", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ ticket: "", access: "", images: [], content: "", deadline: 0, calls: {} }),
});
