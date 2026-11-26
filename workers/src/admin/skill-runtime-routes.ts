import { Type } from "typebox";
import { Check } from "typebox/value";
import type { AdminRoute } from "./routes";
import { HttpError, adminJson as json, readAdminBody } from "./http";
import { SkillActionNameSchema, SkillGroupSchema, SkillNameSchema } from "../skill-runtime/manifest";

const strict = { additionalProperties: false } as const;

function mapSkillRuntimeError(error: unknown): never {
  const code = error instanceof Error ? error.message : "";
  if (code === "skill_not_found") throw new HttpError(404, "skill_not_found");
  if (/^(invalid_skill|invalid_runner|skill_action_owner_only|skill_invalid_grant|skill_grant_limit)$/.test(code)) {
    throw new HttpError(400, code);
  }
  throw error;
}

export const SKILL_RUNTIME_ROUTES: AdminRoute[] = [
  {
    method: "GET",
    path: "/admin/skill-runtime",
    handle: async ({ env }) => {
      const registry = env.REGISTRY.getByName("main");
      const [overview, threads] = await Promise.all([
        registry.skillRuntimeAdminOverview(),
        env.BRIDGE.getByName("napcat").threadList().catch(() => []),
      ]);
      const skills = await Promise.all(overview.map(async item => {
        try {
          const state = await env.SANDBOX.getByName("skill-state:" + item.skill).skillStateList(item.skill);
          return { ...item, state };
        } catch {
          return { ...item, state: { error: "unavailable" as const } };
        }
      }));
      const groups = threads
        .filter(thread => thread.key.startsWith("group:"))
        .map(thread => ({ key: thread.key, ...(thread.name ? { name: thread.name } : {}) }));
      return json({ skills, groups });
    },
  },
  {
    method: "PUT",
    path: /^\/admin\/skill-runtime\/(?<name>[^/]{1,128})\/grants$/,
    handle: async ({ env, params, request }) => {
      if (!Check(SkillNameSchema, params.name)) throw new HttpError(400, "invalid_skill");
      const body = await readAdminBody(request, Type.Object({
        group: SkillGroupSchema,
        actions: Type.Array(SkillActionNameSchema, { maxItems: 32 }),
      }, strict));
      try {
        return json(await env.REGISTRY.getByName("main").skillRuntimeGrant(params.name, body.group, body.actions));
      } catch (error) {
        mapSkillRuntimeError(error);
      }
    },
  },
  {
    method: "POST",
    path: /^\/admin\/skill-runtime\/(?<name>[^/]{1,128})\/state\/clear$/,
    handle: async ({ env, params }) => {
      if (!Check(SkillNameSchema, params.name)) throw new HttpError(400, "invalid_skill");
      const registry = env.REGISTRY.getByName("main");
      try {
        await registry.skillRuntimeResolveOwnerSkill(params.name);
      } catch (error) {
        mapSkillRuntimeError(error);
      }
      await env.SANDBOX.getByName("skill-state:" + params.name).skillStateClear(params.name);
      await registry.skillRuntimeAuthResolved(params.name);
      return json({ skill: params.name, cleared: true });
    },
  },
];
