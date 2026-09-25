import { letterboxdConfig, VERSION, type Env } from "../env";
import { forceRefreshAccessToken, getAccessToken, tokenStore } from "./tokens";
import { LetterboxdApiError } from "./errors";
import type { StoredTokens } from "./token-store";

export { LetterboxdApiError, LetterboxdNotLinkedError } from "./errors";

/**
 * The Letterboxd API client: one place that knows about HTTP, retries, errors
 * and the edge cache. The data source can be swapped behind this module.
 */

export const LETTERBOXD_API = "https://api.letterboxd.com/api/v0";
export const LETTERBOXD_TOKEN_URL = `${LETTERBOXD_API}/auth/token`;
export const LETTERBOXD_AUTHORIZE_URL = `${LETTERBOXD_API}/auth/authorize`;
export const LETTERBOXD_SCOPES =
  "content:modify profile:private:view oauth:refresh";

const REQUEST_TIMEOUT_MS = 15_000;
const TOOL_DEADLINE_MS = 25_000;

export type QueryValue =
  | string
  | number
  | boolean
  | undefined
  | (string | number)[];

export interface LbRequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Which upstream token to use. Defaults to "any" (member when linked). */
  auth?: "member" | "app" | "any";
  /** Seconds to cache a public GET in the edge cache. Only used for app-token GETs. */
  cacheTtl?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface ErrorBody {
  message?: string;
  errors?: { code?: string | number; message?: string }[];
}

function userAgent(env: Env): string {
  return `letterboxd-mcp/${VERSION} (+${env.PUBLIC_URL})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function buildUrl(path: string, query?: LbRequestOptions["query"]): string {
  const url = /^https?:\/\//i.test(path)
    ? new URL(path)
    : new URL(`${LETTERBOXD_API}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        // Letterboxd expects exploded form arrays: where=A&where=B.
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return 1_000;
}

async function toApiError(env: Env, response: Response): Promise<LetterboxdApiError> {
  let detail: string | undefined;
  let code: string | undefined;
  try {
    const body = (await response.json()) as ErrorBody;
    const first = body.errors?.[0];
    detail = first?.message ?? body.message;
    if (first?.code !== undefined) code = String(first.code);
  } catch {
    // Non-JSON error bodies carry no extra detail.
  }
  const status = response.status;
  let message: string;
  if (status === 400) {
    message = detail
      ? `Letterboxd rejected the request: ${detail}`
      : "Letterboxd rejected the request.";
  } else if (status === 401) {
    message = `Letterboxd session expired; relink at ${env.PUBLIC_URL}/letterboxd/relink`;
  } else if (status === 403) {
    message = "Not allowed (private content or missing permission)";
  } else if (status === 404) {
    message = detail ? `Not found: ${detail}` : "Not found";
  } else if (status === 429) {
    message = "Rate limited by Letterboxd";
  } else if (status >= 500) {
    message = "Letterboxd is unavailable";
  } else {
    message = detail
      ? `Letterboxd request failed (${status}): ${detail}`
      : `Letterboxd request failed (${status})`;
  }
  return new LetterboxdApiError(status, message, code);
}

async function accessTokenFor(env: Env, auth: "member" | "app" | "any"): Promise<string> {
  return (await getAccessToken(env, auth)).token;
}

async function perform(
  env: Env,
  method: string,
  url: string,
  body: unknown,
  auth: "member" | "app" | "any",
  allowRefresh = true,
): Promise<Response> {
  const deadline = Date.now() + TOOL_DEADLINE_MS;
  let rateLimitRetries = 0;
  let serverRetries = 0;
  let networkRetries = 0;

  for (;;) {
    const token = await accessTokenFor(env, auth);
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": userAgent(env),
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (networkRetries++ < 1 && Date.now() < deadline) {
        await sleep(250);
        continue;
      }
      throw new LetterboxdApiError(
        0,
        `Could not reach Letterboxd: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.ok) return response;

    if (response.status === 401 && allowRefresh) {
      await forceRefreshAccessToken(env, auth);
      return perform(env, method, url, body, auth, false);
    }
    if (response.status === 429 && rateLimitRetries++ < 2 && Date.now() < deadline) {
      await sleep(Math.min(parseRetryAfter(response.headers.get("retry-after")), deadline - Date.now()));
      continue;
    }
    if (response.status >= 500 && serverRetries++ < 1 && Date.now() < deadline) {
      await sleep(250);
      continue;
    }
    throw await toApiError(env, response);
  }
}

/** True when a healthy member token exists; used to decide if a response is safe to cache. */
async function memberLinked(env: Env): Promise<boolean> {
  const status = await tokenStore(env).status();
  return status.linked && !status.broken;
}

export async function lbRequest<T>(
  env: Env,
  method: string,
  path: string,
  options: LbRequestOptions = {},
): Promise<T> {
  const url = buildUrl(path, options.query);
  const auth = options.auth ?? "any";
  const wantsCache = method.toUpperCase() === "GET" && (options.cacheTtl ?? 0) > 0;
  // Never cache member-specific responses: only app-token public GETs qualify.
  const cacheable =
    wantsCache && (auth === "app" || (auth === "any" && !(await memberLinked(env))));

  if (cacheable) {
    const hit = await caches.default.match(url);
    if (hit) return (await hit.json()) as T;
  }

  const response = await perform(env, method, url, options.body, auth);
  if (response.status === 204) return undefined as T;
  const data = (await response.json()) as T;

  if (cacheable) {
    const ttl = options.cacheTtl ?? 0;
    try {
      await caches.default.put(
        url,
        new Response(JSON.stringify(data), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${ttl}`,
          },
        }),
      );
    } catch {
      // Caching is best effort; a failed put must not fail the request.
    }
  }
  return data;
}

interface RawPage<T> {
  items?: T[];
  next?: string | null;
}

function cursorFrom(next: string | null): string | null {
  if (!next) return null;
  try {
    return new URL(next).searchParams.get("cursor");
  } catch {
    return next;
  }
}

export async function lbPaginate<T>(
  env: Env,
  path: string,
  query: LbRequestOptions["query"] = {},
  options: {
    auth?: "member" | "app" | "any";
    cacheTtl?: number;
    maxItems?: number;
    maxPages?: number;
  } = {},
): Promise<Page<T>> {
  const maxPages = options.maxPages ?? 10;
  const maxItems = options.maxItems ?? 1_000;
  const auth = options.auth ?? "any";
  const items: T[] = [];
  let next: string | null = null;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const response: RawPage<T> = next
      ? await lbRequest<RawPage<T>>(env, "GET", next, { auth })
      : await lbRequest<RawPage<T>>(env, "GET", path, {
          query,
          auth,
          cacheTtl: options.cacheTtl,
        });
    if (Array.isArray(response.items)) items.push(...response.items);
    next = typeof response.next === "string" && response.next.length > 0 ? response.next : null;
    if (!next) break;
    if (items.length >= maxItems) {
      truncated = true;
      break;
    }
  }

  return { items, nextCursor: cursorFrom(next), truncated };
}

function publicBase(env: Env): string {
  return env.PUBLIC_URL.replace(/\/$/, "");
}

export function letterboxdRedirectUri(env: Env): string {
  return `${publicBase(env)}/letterboxd/callback`;
}

export function letterboxdAuthorizeUrl(env: Env, state: string): string {
  const config = letterboxdConfig(env);
  if (!config) throw new Error("Letterboxd API credentials are not configured");
  const url = new URL(LETTERBOXD_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", letterboxdRedirectUri(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", LETTERBOXD_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

/** POSTs to the Letterboxd token endpoint. 4xx bodies are returned so callers can inspect `error`. */
export async function requestTokens(
  env: Env,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const config = letterboxdConfig(env);
  if (!config) throw new Error("Letterboxd API credentials are not configured");
  const response = await fetch(LETTERBOXD_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": userAgent(env),
    },
    body: new URLSearchParams({
      ...body,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let parsed: TokenResponse;
  try {
    parsed = (await response.json()) as TokenResponse;
  } catch {
    throw new LetterboxdApiError(
      response.status,
      `Letterboxd token endpoint returned ${response.status}`,
    );
  }
  if (!response.ok && !parsed.error) {
    throw new LetterboxdApiError(
      response.status,
      `Letterboxd token endpoint returned ${response.status}`,
    );
  }
  return parsed;
}

export async function exchangeAuthorizationCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<StoredTokens> {
  const response = await requestTokens(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  if (!response.access_token) {
    throw new LetterboxdApiError(
      400,
      response.error_description ??
        response.error ??
        "Letterboxd rejected the authorization code",
    );
  }
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + (response.expires_in ?? 3_600) * 1_000,
    scope: response.scope,
  };
}

export async function fetchMemberIdentity(
  env: Env,
  accessToken: string,
): Promise<{ id: string; username: string; displayName?: string }> {
  const response = await fetch(`${LETTERBOXD_API}/me`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": userAgent(env),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await toApiError(env, response);
  const body = (await response.json()) as Record<string, unknown>;
  // The docs describe /me as account settings, but the member identity has
  // historically been nested under `member`; accept either shape.
  const nested = typeof body.member === "object" && body.member !== null ? (body.member as Record<string, unknown>) : null;
  const member = nested ?? body;
  const id = member.id;
  const username = member.username;
  if (typeof id !== "string" || typeof username !== "string") {
    throw new LetterboxdApiError(
      502,
      "Letterboxd did not return a member identity from /me",
    );
  }
  return {
    id,
    username,
    displayName: typeof member.displayName === "string" ? member.displayName : undefined,
  };
}
