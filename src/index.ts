import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { authApp } from "./auth/app";
import { SCOPE_READ, SCOPE_WRITE, type Env } from "./env";
import { createMcpApiHandler } from "./mcp/handler";
import { LetterboxdTokenStore } from "./upstream/token-store";

export { LetterboxdTokenStore };

// `resourceMetadata.resource` must be absolute and PUBLIC_URL only exists on
// `env`, so provider construction is deferred. One provider per isolate/host.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(env: Env): OAuthProvider<Env> {
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  let provider = providers.get(base);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      // The factory's declared return type keeps `fetch` optional, but the
      // provider requires a handler that is guaranteed to have one.
      apiHandler: createMcpApiHandler() as ExportedHandler<Env> &
        Required<Pick<ExportedHandler<Env>, "fetch">>,
      defaultHandler: authApp,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: [SCOPE_READ, SCOPE_WRITE],
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
      refreshTokenTTL: 60 * 60 * 24 * 30,
      resourceMetadata: {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: [SCOPE_READ, SCOPE_WRITE],
        resource_name: "Letterboxd MCP",
      },
    });
    providers.set(base, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    let provider: OAuthProvider<Env>;
    try {
      provider = providerFor(env);
    } catch (error) {
      // A placeholder or malformed PUBLIC_URL must fail loudly, not silently.
      return new Response(
        `letterboxd-mcp is misconfigured: ${error instanceof Error ? error.message : String(error)}. ` +
          "Set PUBLIC_URL in wrangler.jsonc (or .dev.vars) to the origin this Worker is served from.",
        { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
