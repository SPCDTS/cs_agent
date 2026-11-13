import { Type, type Static } from "typebox";

export const EVENT_NAME = "^[a-z_]{1,40}$";
// Reserved because these describe account/installation authority or non-repository control,
// not ordinary repository notifications. No blanket prefix ban for future event names.
export const CONTROL_EVENTS = ["ping", "installation", "installation_repositories", "repository", "github_app_authorization"] as const;
const RESERVED = new Set<string>([...CONTROL_EVENTS, "meta", "membership", "organization", "org_block", "team", "team_add", "personal_access_token_request", "deployment_protection_rule"]);
export const reservedEvent = (event: string) => RESERVED.has(event);
export const RuleSchema = Type.Object({
  event: Type.String({ pattern: EVENT_NAME }),
  actions: Type.Union([Type.Literal("*"), Type.Array(Type.String({ pattern: "^(?:[a-z_]{1,40})?$" }), { minItems: 1, maxItems: 32, uniqueItems: true })]),
  subject: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("issue"), Type.Literal("pull_request")])),
}, { additionalProperties: false });
export type GitHubRule = Static<typeof RuleSchema>;
export const CommentFiltersSchema = Type.Object({
  excludeConnectedUser: Type.Boolean(), ignoreBots: Type.Boolean(),
}, { additionalProperties: false });
export const DEFAULT_COMMENT_FILTERS = { excludeConnectedUser: false, ignoreBots: false };
export function ruleMatches(rule: GitHubRule, event: string, action: string, subject: string) {
  return rule.event === event && (rule.actions === "*" || rule.actions.includes(action))
    && (!rule.subject || rule.subject === "any" || rule.subject === subject);
}
