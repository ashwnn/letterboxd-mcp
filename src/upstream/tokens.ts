import type { Env } from "../env";
import { rebuildRpcError } from "./errors";
import type { LetterboxdTokenStore, TokenWithExpiry } from "./token-store";

/**
 * Best-effort per-isolate token cache in front of the Durable Object. Tokens are
 * reused while more than 60s of life remain; anything else asks the DO, which is
 * the only place that refreshes.
 */

export interface AccessToken {
  token: string;
  expiresAt: number;
  kind: "member" | "app";
}

export type TokenKind = "member" | "app" | "any";

const REFRESH_MARGIN_MS = 60_000;
const cache = new Map<TokenKind, AccessToken>();

export function tokenStore(env: Env): DurableObjectStub<LetterboxdTokenStore> {
  return env.LB_TOKENS.get(env.LB_TOKENS.idFromName("owner"));
}

function cacheable(cached: AccessToken | undefined): cached is AccessToken {
  return cached !== undefined && cached.expiresAt - REFRESH_MARGIN_MS > Date.now();
}

function remember(kind: TokenKind, result: TokenWithExpiry): AccessToken {
  const value: AccessToken = {
    token: result.token,
    expiresAt: result.expiresAt,
    kind: result.kind,
  };
  cache.set(kind, value);
  return value;
}

export async function getAccessToken(env: Env, kind: TokenKind): Promise<AccessToken> {
  const cached = cache.get(kind);
  if (cacheable(cached)) return cached;
  try {
    return remember(kind, await tokenStore(env).getToken(kind));
  } catch (error) {
    return rebuildRpcError(error);
  }
}

/** Convenience string form, used by tests and simple call sites. */
export async function getToken(env: Env, kind: TokenKind): Promise<string> {
  return (await getAccessToken(env, kind)).token;
}

export async function forceRefreshAccessToken(
  env: Env,
  kind: TokenKind,
): Promise<AccessToken> {
  try {
    return remember(kind, await tokenStore(env).forceRefresh(kind));
  } catch (error) {
    return rebuildRpcError(error);
  }
}

export function clearTokenCache(): void {
  cache.clear();
}
