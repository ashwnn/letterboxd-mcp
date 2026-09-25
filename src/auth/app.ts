import { Hono } from "hono";
import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import {
  grantedScopes,
  letterboxdConfig,
  type AuthProps,
  type Env,
} from "../env";
import {
  consentPage,
  errorPage,
  homePage,
  htmlResponse,
  relinkPage,
} from "./html";
import {
  loginRateLimited,
  recordLoginFailure,
  verifyPassword,
} from "./password";
import {
  LetterboxdApiError,
  LetterboxdNotLinkedError,
  exchangeAuthorizationCode,
  fetchMemberIdentity,
  letterboxdAuthorizeUrl,
  letterboxdRedirectUri,
} from "../upstream/client";
import { clearTokenCache, tokenStore } from "../upstream/tokens";

const RELINK_COOKIE = "__Host-lb-relink";
const RELINK_TTL_SECONDS = 600;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await sha256(value);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(signature));
}

async function relinkRecordKey(state: string): Promise<string> {
  return `relink:${await sha256Hex(state)}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function isAllowedRedirectHost(env: Env, host: string): boolean {
  const allowed = env.ALLOWED_REDIRECT_HOSTS.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.includes(host)) return true;
  const isDev = env.ENVIRONMENT === "dev";
  return isDev && (host === "localhost" || host === "127.0.0.1");
}

function missingSecrets(env: Env): string[] {
  const missing: string[] = [];
  if (!env.ADMIN_PASSWORD) missing.push("ADMIN_PASSWORD");
  if (!letterboxdConfig(env)) {
    missing.push("LETTERBOXD_CLIENT_ID", "LETTERBOXD_CLIENT_SECRET");
  }
  return missing;
}

/** `AuthorizationError` with a validated redirect URI: send the error back to the client. */
function redirectAuthError(error: AuthorizationError): Response | null {
  if (!error.redirectUri) return null;
  const target = new URL(error.redirectUri);
  target.searchParams.set("error", error.code);
  target.searchParams.set("error_description", error.description);
  if (error.state) target.searchParams.set("state", error.state);
  if (error.issuer) target.searchParams.set("iss", error.issuer);
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString(), "Cache-Control": "no-store" },
  });
}

async function safeLookupClient(
  env: Env,
  clientId: string,
): Promise<ClientInfo | null> {
  try {
    return await env.OAUTH_PROVIDER.lookupClient(clientId);
  } catch (error) {
    if (error instanceof CimdFetchError) return null;
    throw error;
  }
}

function upstreamErrorPage(error: unknown): string {
  if (error instanceof LetterboxdNotLinkedError) {
    return errorPage(
      "The Letterboxd connection is no longer valid. Reconnect and try again.",
    );
  }
  if (error instanceof LetterboxdApiError) {
    return errorPage(
      `Letterboxd rejected the request (HTTP ${error.status}). Try again later.`,
    );
  }
  return errorPage("Could not reach Letterboxd. Try again later.");
}

async function renderConsent(
  env: Env,
  oauthReq: AuthRequest,
  error?: string,
  status = 200,
): Promise<Response> {
  const client = await safeLookupClient(env, oauthReq.clientId);
  const consent = await env.OAUTH_PROVIDER.beginConsent(oauthReq);
  return htmlResponse(
    consentPage({
      clientName: client?.clientName ?? "MCP client",
      redirectHost: new URL(oauthReq.redirectUri).hostname,
      scopes: grantedScopes(env, oauthReq.scope),
      handle: consent.handle,
      error,
    }),
    consent.headers,
    status,
  );
}

async function relinkCallback(
  env: Env,
  code: string | null,
  error: string | null,
): Promise<Response> {
  if (error) {
    return htmlResponse(
      errorPage("Letterboxd authorization was cancelled."),
      undefined,
      400,
    );
  }
  if (!code) {
    return htmlResponse(
      errorPage("Letterboxd did not return an authorization code."),
      undefined,
      400,
    );
  }
  if (!letterboxdConfig(env)) {
    return htmlResponse(
      errorPage(
        "Server configuration incomplete. Missing: LETTERBOXD_CLIENT_ID, LETTERBOXD_CLIENT_SECRET.",
      ),
      undefined,
      500,
    );
  }
  try {
    const tokens = await exchangeAuthorizationCode(
      env,
      code,
      letterboxdRedirectUri(env),
    );
    const member = await fetchMemberIdentity(env, tokens.accessToken);
    await tokenStore(env).saveMemberTokens(tokens, member);
  } catch (err) {
    return htmlResponse(upstreamErrorPage(err), undefined, 502);
  }
  await clearTokenCache();
  const headers = new Headers({
    Location: "/?linked=1",
    "Cache-Control": "no-store",
  });
  headers.append(
    "Set-Cookie",
    `${RELINK_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  );
  return new Response(null, { status: 302, headers });
}

async function mcpCallback(
  env: Env,
  request: Request,
  code: string | null,
  error: string | null,
): Promise<Response> {
  let resumed;
  try {
    resumed = await env.OAUTH_PROVIDER.finishUpstream<Record<string, never>>(
      request,
    );
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return htmlResponse(
        errorPage("This sign-in link expired or was already used. Start again."),
        undefined,
        400,
      );
    }
    if (err instanceof CimdFetchError) {
      return htmlResponse(
        errorPage("Could not load the client's metadata. Try again later."),
        undefined,
        502,
      );
    }
    throw err;
  }

  const original = resumed.request;
  const headers = resumed.headers;

  if (error) {
    const target = new URL(original.redirectUri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set(
      "error_description",
      "Letterboxd authorization was not completed.",
    );
    if (original.state) target.searchParams.set("state", original.state);
    if (original.issuer) target.searchParams.set("iss", original.issuer);
    headers.set("Location", target.toString());
    return new Response(null, { status: 302, headers });
  }
  if (!code) {
    return htmlResponse(
      errorPage("Letterboxd did not return an authorization code."),
      undefined,
      400,
    );
  }

  try {
    const tokens = await exchangeAuthorizationCode(
      env,
      code,
      letterboxdRedirectUri(env),
    );
    const member = await fetchMemberIdentity(env, tokens.accessToken);
    await tokenStore(env).saveMemberTokens(tokens, member);
  } catch (err) {
    return htmlResponse(upstreamErrorPage(err), undefined, 502);
  }
  await clearTokenCache();

  const scopes = grantedScopes(env, original.scope);
  const client = await safeLookupClient(env, original.clientId);
  let completed;
  try {
    completed = await env.OAUTH_PROVIDER.completeAuthorization({
      request: original,
      userId: "owner",
      metadata: { clientName: client?.clientName ?? "MCP client" },
      scope: scopes,
      props: { userId: "owner", scopes } satisfies AuthProps,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return htmlResponse(
        errorPage("Authorization could not be completed. Start again."),
        undefined,
        400,
      );
    }
    throw err;
  }
  headers.set("Location", completed.redirectTo);
  return new Response(null, { status: 302, headers });
}

export const authApp = new Hono<{ Bindings: Env }>();

authApp.get("/", (c) => {
  const base = c.env.PUBLIC_URL.replace(/\/$/, "");
  return htmlResponse(
    homePage(`${base}/mcp`, {
      linked: c.req.query("linked") === "1",
      unlinked: c.req.query("unlinked") === "1",
    }),
  );
});

authApp.get("/authorize", async (c) => {
  const env = c.env;

  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      const redirected = redirectAuthError(err);
      if (redirected) return redirected;
      return htmlResponse(errorPage(err.description), undefined, 400);
    }
    if (err instanceof CimdFetchError) {
      return htmlResponse(
        errorPage("Could not load the client's metadata. Try again later."),
        undefined,
        502,
      );
    }
    throw err;
  }

  let client: ClientInfo | null;
  try {
    client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  } catch (err) {
    if (err instanceof CimdFetchError) {
      return htmlResponse(
        errorPage("Could not load the client's metadata. Try again later."),
        undefined,
        502,
      );
    }
    throw err;
  }
  if (!client) {
    return htmlResponse(errorPage("Unknown client."), undefined, 400);
  }

  const redirectHost = new URL(oauthReq.redirectUri).hostname;
  if (!isAllowedRedirectHost(env, redirectHost)) {
    return htmlResponse(
      errorPage(`Redirect host "${redirectHost}" is not allowed.`),
      undefined,
      400,
    );
  }

  const missing = missingSecrets(env);
  if (missing.length > 0) {
    return htmlResponse(
      errorPage(
        `Server configuration incomplete. Missing: ${missing.join(", ")}.`,
      ),
      undefined,
      500,
    );
  }

  return renderConsent(env, oauthReq);
});

authApp.post("/authorize", async (c) => {
  const env = c.env;
  const form = await c.req.formData();
  const handle = String(form.get("handle") ?? "");
  const password = String(form.get("password") ?? "");
  const decision = String(form.get("decision") ?? "");
  const submittedScopes = form
    .getAll("scope")
    .map((value) => String(value))
    .filter((value) => value.length > 0);

  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (await loginRateLimited(env, ip)) {
    return htmlResponse(
      errorPage("Too many attempts. Try again later."),
      undefined,
      429,
    );
  }

  if (decision !== "approve") {
    try {
      const denied = await env.OAUTH_PROVIDER.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return htmlResponse(errorPage(err.description), undefined, 400);
      }
      throw err;
    }
  }

  // The form posts to the same URL, so the original query string is intact.
  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    if (
      err instanceof AuthorizationError ||
      err instanceof CimdFetchError
    ) {
      return htmlResponse(
        errorPage("Your authorization session expired. Start again."),
        undefined,
        400,
      );
    }
    throw err;
  }

  if (!(await verifyPassword(env, password))) {
    await recordLoginFailure(env, ip);
    try {
      return await renderConsent(
        env,
        oauthReq,
        "Incorrect password. Try again.",
        401,
      );
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return htmlResponse(errorPage(err.description), undefined, 400);
      }
      throw err;
    }
  }

  const grantable = grantedScopes(env, oauthReq.scope);
  const chosen = submittedScopes.filter((scope) => grantable.includes(scope));
  const scopes = chosen.length > 0 ? chosen : grantable;

  let approved;
  try {
    approved = await env.OAUTH_PROVIDER.approveConsent(c.req.raw, handle, {
      scope: scopes,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return htmlResponse(
        errorPage("Your authorization session expired. Start again."),
        undefined,
        400,
      );
    }
    throw err;
  }

  const status = await tokenStore(env).status();
  if (status.linked && !status.broken) {
    const client = await safeLookupClient(env, approved.request.clientId);
    const completed = await env.OAUTH_PROVIDER.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: { clientName: client?.clientName ?? "MCP client" },
      scope: scopes,
      props: { userId: "owner", scopes } satisfies AuthProps,
    });
    const headers = new Headers(approved.headers);
    headers.set("Location", completed.redirectTo);
    return new Response(null, { status: 302, headers });
  }

  const upstream = await env.OAUTH_PROVIDER.beginUpstream(approved.request, {
    data: {},
    headers: approved.headers,
  });
  upstream.headers.set(
    "Location",
    letterboxdAuthorizeUrl(env, upstream.state),
  );
  return new Response(null, { status: 302, headers: upstream.headers });
});

authApp.get("/letterboxd/callback", async (c) => {
  const env = c.env;
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? null;
  const error = c.req.query("error") ?? null;

  if (state) {
    const recordKey = await relinkRecordKey(state);
    if ((await env.OAUTH_KV.get(recordKey)) !== null) {
      const signingKey = env.COOKIE_SIGNING_KEY;
      if (!signingKey) {
        return htmlResponse(
          errorPage(
            "Server configuration incomplete. Missing: COOKIE_SIGNING_KEY.",
          ),
          undefined,
          500,
        );
      }
      const submitted = readCookie(c.req.raw, RELINK_COOKIE);
      const expected = await hmacBase64Url(signingKey, `relink:${state}`);
      const matches =
        submitted !== null &&
        timingSafeEqual(await sha256(submitted), await sha256(expected));
      if (!matches) {
        return htmlResponse(
          errorPage(
            "This reconnection link is not valid in this browser. Start again.",
          ),
          undefined,
          400,
        );
      }
      await env.OAUTH_KV.delete(recordKey);
      return relinkCallback(env, code, error);
    }
  }

  return mcpCallback(env, c.req.raw, code, error);
});

authApp.get("/letterboxd/relink", (c) => {
  const missing = missingSecrets(c.env);
  if (!c.env.COOKIE_SIGNING_KEY) missing.push("COOKIE_SIGNING_KEY");
  if (missing.length > 0) {
    return htmlResponse(
      errorPage(
        `Server configuration incomplete. Missing: ${missing.join(", ")}.`,
      ),
      undefined,
      500,
    );
  }
  return htmlResponse(relinkPage());
});

authApp.post("/letterboxd/relink", async (c) => {
  const env = c.env;
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (await loginRateLimited(env, ip)) {
    return htmlResponse(
      errorPage("Too many attempts. Try again later."),
      undefined,
      429,
    );
  }

  const form = await c.req.formData();
  const password = String(form.get("password") ?? "");
  if (!(await verifyPassword(env, password))) {
    await recordLoginFailure(env, ip);
    return htmlResponse(
      relinkPage({ error: "Incorrect password. Try again." }),
      undefined,
      401,
    );
  }

  const signingKey = env.COOKIE_SIGNING_KEY;
  const config = letterboxdConfig(env);
  if (!signingKey || !config) {
    const missing: string[] = [];
    if (!signingKey) missing.push("COOKIE_SIGNING_KEY");
    if (!config) missing.push("LETTERBOXD_CLIENT_ID", "LETTERBOXD_CLIENT_SECRET");
    return htmlResponse(
      errorPage(
        `Server configuration incomplete. Missing: ${missing.join(", ")}.`,
      ),
      undefined,
      500,
    );
  }

  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.OAUTH_KV.put(await relinkRecordKey(state), "1", {
    expirationTtl: RELINK_TTL_SECONDS,
  });
  const signature = await hmacBase64Url(signingKey, `relink:${state}`);
  const headers = new Headers({
    Location: letterboxdAuthorizeUrl(env, state),
    "Cache-Control": "no-store",
  });
  headers.append(
    "Set-Cookie",
    `${RELINK_COOKIE}=${signature}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${RELINK_TTL_SECONDS}`,
  );
  return new Response(null, { status: 302, headers });
});

authApp.post("/letterboxd/unlink", async (c) => {
  const env = c.env;
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (await loginRateLimited(env, ip)) {
    return htmlResponse(
      errorPage("Too many attempts. Try again later."),
      undefined,
      429,
    );
  }

  const form = await c.req.formData();
  const password = String(form.get("password") ?? "");
  if (!(await verifyPassword(env, password))) {
    await recordLoginFailure(env, ip);
    return htmlResponse(errorPage("Incorrect password."), undefined, 401);
  }

  await tokenStore(env).unlink();
  await clearTokenCache();
  return new Response(null, {
    status: 302,
    headers: { Location: "/?unlinked=1", "Cache-Control": "no-store" },
  });
});
