import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { LetterboxdTokenStore } from "./upstream/token-store";

/**
 * Bindings and secrets for the Worker. Hand-written (rather than relying on the
 * generated `Cloudflare.Env`) because secrets are optional at build time and are
 * checked at request time so the Worker can serve metadata without them.
 */
export interface Env {
  OAUTH_KV: KVNamespace;
  LOOKUP_KV: KVNamespace;
  LB_TOKENS: DurableObjectNamespace<LetterboxdTokenStore>;
  LOGIN_LIMITER?: RateLimit;
  PUBLIC_URL: string;
  TIMEZONE: string;
  READ_ONLY: string;
  ALLOWED_REDIRECT_HOSTS: string;
  ENVIRONMENT: string;
  /** Injected by @cloudflare/workers-oauth-provider. */
  OAUTH_PROVIDER: OAuthHelpers;
  ADMIN_PASSWORD?: string;
  LETTERBOXD_CLIENT_ID?: string;
  LETTERBOXD_CLIENT_SECRET?: string;
  COOKIE_SIGNING_KEY?: string;
}

/** Application props stored on every OAuth grant and returned by getMcpAuthContext(). */
export interface AuthProps {
  userId: string;
  scopes: string[];
}

export const SCOPE_READ = "letterboxd:read";
export const SCOPE_WRITE = "letterboxd:write";

export const VERSION = "0.1.0";

export function letterboxdConfig(
  env: Env,
): { clientId: string; clientSecret: string } | null {
  const clientId = env.LETTERBOXD_CLIENT_ID;
  const clientSecret = env.LETTERBOXD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isReadOnly(env: Env): boolean {
  return env.READ_ONLY === "true";
}

/**
 * Decide the scopes actually granted for an authorization. Read is granted when
 * requested (or when the client requests nothing at all); write only when
 * requested and the READ_ONLY kill switch is off.
 */
export function grantedScopes(env: Env, requested: string[]): string[] {
  const wantsEverything = requested.length === 0;
  const granted: string[] = [];
  if (wantsEverything || requested.includes(SCOPE_READ)) granted.push(SCOPE_READ);
  if ((wantsEverything || requested.includes(SCOPE_WRITE)) && !isReadOnly(env)) {
    granted.push(SCOPE_WRITE);
  }
  return granted;
}
