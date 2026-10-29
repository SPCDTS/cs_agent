import { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { createOAuthFetch, OAuthFailure } from "./oauth-fetch";
import { httpsUrl, type OAuthServer } from "./config";

export const DiscoverySchema = Type.Object({ issuer: Type.String(), authorization: Type.String(), token: Type.String(), resource: Type.String() }, { additionalProperties: false });
export type Discovery = Static<typeof DiscoverySchema>;
const Tokens = Type.Object({ access_token: Type.String({ minLength: 1, maxLength: 65536, pattern: "^[^\\s\\u0000-\\u001f\\u007f]+$" }),
  refresh_token: Type.Optional(Type.String({ minLength: 1, maxLength: 65536 })), token_type: Type.String(),
  expires_in: Type.Optional(Type.Number({ minimum: 0, maximum: 315360000 })), scope: Type.Optional(Type.String({ maxLength: 4096 })) });
export type OAuthTokens = Static<typeof Tokens>;
export class TokenRejected extends Error { constructor() { super("auth_required"); } }

export async function discover(server: OAuthServer, expectedIssuer?: string): Promise<Discovery> {
  const origin = httpsUrl(server.transport.url).origin;
  const origins = [origin];
  if (expectedIssuer) origins.push(httpsUrl(expectedIssuer).origin);
  const fetchFn = createOAuthFetch(() => origins);
  try {
    let missing = false;
    const resource = await discoverOAuthProtectedResourceMetadata(server.transport.url, undefined, async (url, init) => {
      const response = await fetchFn(url, init); missing = response.status === 404; return response;
    }).catch(error => { if (!missing) throw error; return undefined; });
    const issuer = httpsUrl(resource?.authorization_servers?.[0] ?? `${origin}/`).href;
    if (expectedIssuer && issuer !== httpsUrl(expectedIssuer).href) throw new OAuthFailure("oauth_metadata");
    origins.push(httpsUrl(issuer).origin);
    const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn });
    if (!metadata || httpsUrl(metadata.issuer).href !== issuer || metadata.client_id_metadata_document_supported !== true
      || !metadata.code_challenge_methods_supported?.includes("S256") || !metadata.token_endpoint) throw new OAuthFailure("oauth_metadata");
    const authorization = httpsUrl(metadata.authorization_endpoint), token = httpsUrl(metadata.token_endpoint);
    if (authorization.origin !== httpsUrl(issuer).origin || !origins.includes(token.origin)) throw new OAuthFailure("oauth_metadata");
    if (resource && !checkResourceAllowed({ requestedResource: server.transport.url, configuredResource: resource.resource })) throw new OAuthFailure("oauth_metadata");
    return { issuer, authorization: authorization.href, token: token.href, resource: resource?.resource ?? server.transport.url };
  } catch (error) { throw error instanceof OAuthFailure ? error : new OAuthFailure("oauth_metadata"); }
}

export async function exchange(server: OAuthServer, discovery: Discovery, fields: Record<string, string>): Promise<OAuthTokens> {
  // CIMD 直接作为 client_id；不使用 authProvider，杜绝 SDK 意外触发 DCR 或浏览器登录。
  const response = await createOAuthFetch(() => [httpsUrl(server.transport.url).origin, httpsUrl(discovery.issuer).origin])(discovery.token, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, client_id: server.credential.clientMetadataUrl, resource: discovery.resource }),
  });
  if (response.status >= 500) throw new OAuthFailure("oauth_network");
  const value: unknown = await response.json().catch(() => { throw new OAuthFailure("oauth_token"); });
  if (!response.ok) {
    if (Check(Type.Object({ error: Type.Union([Type.Literal("invalid_grant"), Type.Literal("invalid_client"), Type.Literal("unauthorized_client")]) }), value)) throw new TokenRejected();
    throw new OAuthFailure("oauth_token");
  }
  if (!Check(Tokens, value) || value.token_type.toLowerCase() !== "bearer") throw new OAuthFailure("oauth_token");
  return value;
}
