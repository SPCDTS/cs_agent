import { Type, type Static } from "typebox";

const common = {
  id: Type.String(), thread: Type.String(),
  activity: Type.Union([Type.Literal("active"), Type.Literal("recent"), Type.Literal("error"), Type.Literal("context")]),
  lastActiveAt: Type.Union([Type.Number(), Type.Null()]),
};
const AgentNodeSchema = Type.Union([
  Type.Object({ ...common, kind: Type.Literal("thread"), parentId: Type.Null() }),
  Type.Object({ ...common, kind: Type.Literal("subagent"), parentId: Type.String(), actor: Type.String(),
    status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Null()]),
    summary: Type.Union([Type.String(), Type.Null()]),
    description: Type.Union([Type.Object({ kind: Type.Union([Type.Literal("task"), Type.Literal("progress"), Type.Literal("result")]), text: Type.String(), updatedAt: Type.Number() }), Type.Null()]),
  }),
]);
export const AgentTopologySchema = Type.Object({ nodes: Type.Array(AgentNodeSchema), since: Type.Number(), sampledAt: Type.Number() });
export type AgentNode = Static<typeof AgentNodeSchema>;
export type AgentTopology = Static<typeof AgentTopologySchema>;
export type AgentFamily = { parent: Extract<AgentNode, { kind: "thread" }>; children: Extract<AgentNode, { kind: "subagent" }>[] };
