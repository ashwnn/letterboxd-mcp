import type { Env } from "../env";
import { VERSION } from "../env";
import { LetterboxdApiError, LetterboxdNotLinkedError, lbRequest } from "./client";
import { tokenStore } from "./tokens";

/**
 * Reference resolution: turn whatever the model passes (LID, slug, URL, tmdb/imdb
 * id, username) into a Letterboxd id. Successful resolutions are cached in KV and
 * in module scope; failures are never cached.
 */

const LOOKUP_TTL_SECONDS = 7 * 24 * 60 * 60;
const MODULE_CACHE_MAX = 500;
// ponytail: insertion-order LRU, fine for a single-owner server; swap for a real
// cache if a multi-tenant fork ever needs it.
const moduleCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const value = moduleCache.get(key);
  if (value !== undefined) {
    moduleCache.delete(key);
    moduleCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: string): void {
  moduleCache.delete(key);
  moduleCache.set(key, value);
  while (moduleCache.size > MODULE_CACHE_MAX) {
    const oldest = moduleCache.keys().next().value;
    if (oldest === undefined) break;
    moduleCache.delete(oldest);
  }
}

/** Test hook: module-scope caches survive KV resets between tests. */
export function clearResolutionCache(): void {
  moduleCache.clear();
}

function userAgent(env: Env): string {
  return `letterboxd-mcp/${VERSION} (+${env.PUBLIC_URL})`;
}

async function cachedLookup(env: Env, key: string): Promise<string | null> {
  const inMemory = cacheGet(key);
  if (inMemory) return inMemory;
  const stored = await env.LOOKUP_KV.get(key);
  if (stored) cacheSet(key, stored);
  return stored;
}

async function rememberLookup(env: Env, key: string, value: string): Promise<void> {
  cacheSet(key, value);
  try {
    await env.LOOKUP_KV.put(key, value, { expirationTtl: LOOKUP_TTL_SECONDS });
  } catch {
    // A KV failure must not fail a successful resolution.
  }
}

/** Documented technique: a HEAD request returns the LID in x-letterboxd-identifier. */
async function headLookup(env: Env, url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": userAgent(env) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new LetterboxdApiError(
      0,
      `Could not resolve ${url}. Use search_films to find the film instead.`,
    );
  }
  const identifier = response.headers.get("x-letterboxd-identifier");
  if (!identifier) {
    throw new LetterboxdApiError(
      response.status || 404,
      `Could not resolve ${url}. Use search_films to find the film instead.`,
    );
  }
  return identifier;
}

const LID_PATTERN = /^[A-Za-z0-9]{4,10}$/;

export async function resolveFilmId(env: Env, input: string): Promise<string> {
  const raw = input.trim();
  if (!raw) throw new Error("A film id, slug, or URL is required.");

  const key = `film:${raw.toLowerCase()}`;
  const cached = await cachedLookup(env, key);
  if (cached) return cached;

  let resolved: string;
  if (/^tmdb:\d+$/i.test(raw)) {
    // Letterboxd accepts tmdb ids directly on /film/{id}; no lookup needed.
    return raw;
  } else if (/^lid:[A-Za-z0-9]+$/.test(raw)) {
    resolved = raw.slice(4);
  } else if (/^imdb:tt\d+$/i.test(raw)) {
    const page = await lbRequest<{ items?: { id?: string }[] }>(env, "GET", "/films", {
      query: { filmId: raw, perPage: 1 },
      auth: "any",
    });
    const id = page.items?.[0]?.id;
    if (!id) throw new LetterboxdApiError(404, `No Letterboxd film matches ${raw}.`);
    resolved = id;
  } else if (/^https?:\/\/boxd\.it\/([A-Za-z0-9]+)/i.test(raw)) {
    resolved = /^https?:\/\/boxd\.it\/([A-Za-z0-9]+)/i.exec(raw)?.[1] ?? raw;
  } else if (raw.startsWith("slug:")) {
    const slug = raw.slice(5).trim();
    resolved = await headLookup(env, `https://letterboxd.com/film/${slug}/`);
  } else if (/^https?:\/\/(www\.)?letterboxd\.com\/film\//i.test(raw)) {
    resolved = await headLookup(env, raw);
  } else if (LID_PATTERN.test(raw)) {
    resolved = raw;
  } else {
    resolved = await headLookup(
      env,
      `https://letterboxd.com/film/${encodeURIComponent(raw)}/`,
    );
  }

  await rememberLookup(env, key, resolved);
  return resolved;
}

export async function resolveMemberId(env: Env, input?: string): Promise<string> {
  const raw = (input ?? "me").trim();
  if (!raw || raw.toLowerCase() === "me") {
    const status = await tokenStore(env).status();
    if (!status.memberId) throw new LetterboxdNotLinkedError();
    return status.memberId;
  }

  const key = `member:${raw.toLowerCase()}`;
  const cached = await cachedLookup(env, key);
  if (cached) return cached;

  let resolved: string;
  if (/^lid:/i.test(raw)) {
    resolved = raw.slice(4);
  } else if (/^https?:\/\/(www\.)?letterboxd\.com\//i.test(raw)) {
    const match = /^https?:\/\/(?:www\.)?letterboxd\.com\/([A-Za-z0-9_]+)/i.exec(raw);
    const username = match?.[1];
    if (!username) throw new Error(`Unrecognized member URL: ${raw}`);
    resolved = await headLookup(env, `https://letterboxd.com/${username}/`);
  } else if (/^[A-Za-z0-9_]{2,15}$/.test(raw)) {
    resolved = await headLookup(env, `https://letterboxd.com/${raw}/`);
  } else {
    throw new Error(`Unrecognized member "${raw}". Pass a username, profile URL, or member id.`);
  }

  await rememberLookup(env, key, resolved);
  return resolved;
}
