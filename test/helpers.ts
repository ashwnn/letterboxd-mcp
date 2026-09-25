import { vi } from "vitest";
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { LETTERBOXD_TOKEN_URL } from "../src/upstream/client";
import type { StoredTokens } from "../src/upstream/token-store";
import { clearTokenCache, tokenStore } from "../src/upstream/tokens";
import me from "./fixtures/me.json";
import tokenResponse from "./fixtures/token-response.json";

export const PUBLIC_URL = "https://letterboxd-mcp.test.workers.dev";
export const ADMIN_PASSWORD = "correct-horse-battery-staple";
export const DEFAULT_REDIRECT_URI = "https://claude.ai/callback";

export const testEnv = env as unknown as Env;

export interface MockCall {
  method: string;
  url: string;
  body: unknown;
}

export type MockReply = (url: URL, init: RequestInit) => Response | Promise<Response>;

export interface MockRoute {
  method?: string;
  match: string | RegExp | ((url: URL) => boolean);
  reply: MockReply;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function jsonReply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function routeMatches(route: MockRoute, method: string, url: URL): boolean {
  if (route.method && route.method.toUpperCase() !== method) return false;
  const match = route.match;
  if (typeof match === "function") return match(url);
  if (match instanceof RegExp) return match.test(url.href);
  return url.href === match || url.href.startsWith(match);
}

export function installFetchMock(routes: MockRoute[]): { calls: MockCall[] } {
  const calls: MockCall[] = [];

  const mock = async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request ? input.clone() : new Request(String(input), init);
    const method = request.method.toUpperCase();
    const url = new URL(request.url);

    let bodyText = "";
    try {
      // Read raw bytes: Request.text() warns on non-text content types (form posts).
      const bytes = await request.clone().arrayBuffer();
      bodyText = new TextDecoder().decode(bytes);
    } catch {
      bodyText = "";
    }
    let body: unknown = bodyText;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") && bodyText.length > 0) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    calls.push({ method, url: url.href, body });

    const route = routes.find((candidate) => routeMatches(candidate, method, url));
    if (!route) {
      throw new Error(
        `Unexpected outbound fetch with no matching mock route: ${method} ${url.href}`,
      );
    }

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const replyInit: RequestInit = {
      method,
      headers,
      ...(bodyText.length > 0 ? { body: bodyText } : {}),
    };
    return await route.reply(url, replyInit);
  };

  vi.stubGlobal("fetch", mock);
  return { calls };
}

export function letterboxdRoute(path: string | RegExp, data: unknown): MockRoute {
  const match =
    typeof path === "string"
      ? new RegExp(`^https://api\\.letterboxd\\.com/api/v0${escapeRegExp(path)}(\\?|$)`)
      : path;
  return { match, reply: () => jsonReply(data) };
}

export function tokenRoute(data: unknown = tokenResponse): MockRoute {
  return { match: LETTERBOXD_TOKEN_URL, reply: () => jsonReply(data) };
}

export function linkedStatusRoutes(): MockRoute[] {
  return [tokenRoute(), letterboxdRoute("/me", me)];
}

export async function seedLinkedMember(
  overrides: Partial<StoredTokens> = {},
): Promise<void> {
  await tokenStore(testEnv).saveMemberTokens(
    {
      accessToken: "member-token",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: "content:modify profile:private:view oauth:refresh",
      ...overrides,
    },
    { id: "2a9q", username: "owner", displayName: "Owner" },
  );
  await clearTokenCache();
}

export async function callWorker(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  // Direct worker.fetch() calls carry no Host header, which MCP host validation needs.
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) headers.set("host", new URL(PUBLIC_URL).host);
  const request = new Request(`${PUBLIC_URL}${path}`, { ...init, headers });
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export function form(params: Record<string, string | string[]>): RequestInit {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) body.append(key, item);
    } else {
      body.set(key, value);
    }
  }
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  };
}

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";", 1)[0] ?? "";
      const equals = pair.indexOf("=");
      if (equals === -1) continue;
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (/max-age=0/i.test(raw)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

export function extractHandle(html: string): string {
  const match =
    /<input[^>]*name="handle"[^>]*value="([^"]+)"/i.exec(html) ??
    /<input[^>]*value="([^"]+)"[^>]*name="handle"/i.exec(html);
  if (!match?.[1]) throw new Error("No handle field found on the consent page");
  return match[1];
}

export interface ClientRegistration {
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string;
  response: Response;
}

export async function registerClient(
  redirectUri: string = DEFAULT_REDIRECT_URI,
  clientName = "Claude Test Client",
): Promise<ClientRegistration> {
  const response = await callWorker("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri] }),
  });
  let clientId: string | null = null;
  let clientSecret: string | null = null;
  try {
    const body = (await response.clone().json()) as Record<string, unknown>;
    if (typeof body.client_id === "string") clientId = body.client_id;
    if (typeof body.client_secret === "string") clientSecret = body.client_secret;
  } catch {
    clientId = null;
  }
  return { clientId, clientSecret, redirectUri, response };
}

export interface AuthorizeOptions {
  scope?: string;
  password?: string;
  ip?: string;
}

export interface AuthorizeStart extends ClientRegistration {
  verifier: string;
  state: string;
  jar: CookieJar;
  page: Response;
  submit: Response;
}

export async function beginAuthorize(
  options: AuthorizeOptions = {},
): Promise<AuthorizeStart> {
  const client = await registerClient(DEFAULT_REDIRECT_URI);
  return submitAuthorize(client, options);
}

export async function submitAuthorize(
  client: ClientRegistration,
  options: AuthorizeOptions = {},
): Promise<AuthorizeStart> {
  if (!client.clientId) {
    throw new Error(
      `Client registration failed (status ${client.response.status}): ${await client.response
        .clone()
        .text()}`,
    );
  }
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await s256Challenge(verifier);
  const state = "test-state";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${PUBLIC_URL}/mcp`,
  });
  if (options.scope) params.set("scope", options.scope);
  const authorizeUrl = `/authorize?${params.toString()}`;

  const page = await callWorker(authorizeUrl);
  const jar = new CookieJar();
  jar.absorb(page);
  const handle = extractHandle(await page.clone().text());

  const fields: Record<string, string | string[]> = {
    handle,
    password: options.password ?? ADMIN_PASSWORD,
    decision: "approve",
  };
  if (options.scope) fields.scope = options.scope;

  const init = form(fields);
  const headers = new Headers(init.headers as Record<string, string>);
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  if (options.ip) headers.set("cf-connecting-ip", options.ip);

  const submit = await callWorker(authorizeUrl, { ...init, headers });
  jar.absorb(submit);
  return {
    ...client,
    clientId: client.clientId,
    verifier,
    state,
    jar,
    page,
    submit,
  };
}

export function exchangeCode(
  start: AuthorizeStart,
  code: string,
  overrides: Record<string, string> = {},
): Promise<Response> {
  return callWorker(
    "/token",
    form({
      grant_type: "authorization_code",
      code,
      redirect_uri: start.redirectUri,
      client_id: start.clientId ?? "",
      client_secret: start.clientSecret ?? "",
      code_verifier: start.verifier,
      resource: `${PUBLIC_URL}/mcp`,
      ...overrides,
    }),
  );
}

export interface OAuthFlowResult extends AuthorizeStart {
  code: string;
  tokenResponse: Response;
  tokenBody: Record<string, unknown>;
  accessToken: string;
  refreshToken: string | null;
}

export async function completeOAuthFlow(
  options: AuthorizeOptions = {},
): Promise<OAuthFlowResult> {
  const start = await beginAuthorize(options);
  const location = start.submit.headers.get("location");
  if (!location) {
    throw new Error(
      `Authorize did not redirect (status ${start.submit.status}): ${await start.submit
        .clone()
        .text()}`,
    );
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`Authorize redirect carries no code: ${location}`);

  const tokenResponse = await exchangeCode(start, code);
  const tokenBody = (await tokenResponse.clone().json()) as Record<string, unknown>;
  const accessToken = tokenBody.access_token;
  const refreshToken = tokenBody.refresh_token;
  if (typeof accessToken !== "string") {
    throw new Error(
      `Token exchange failed (status ${tokenResponse.status}): ${JSON.stringify(tokenBody)}`,
    );
  }
  return {
    ...start,
    code,
    tokenResponse,
    tokenBody,
    accessToken,
    refreshToken: typeof refreshToken === "string" ? refreshToken : null,
  };
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export async function mcpRequest(
  method: string,
  params: unknown,
  accessToken: string,
): Promise<JsonRpcResponse> {
  const response = await callWorker("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return readJsonRpc(response);
}

async function readJsonRpc(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const messages: JsonRpcResponse[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        messages.push(JSON.parse(line.slice(5).trim()) as JsonRpcResponse);
      } catch {
        continue;
      }
    }
    const last = messages[messages.length - 1];
    if (!last) {
      throw new Error(`No JSON-RPC message in SSE response: ${text.slice(0, 200)}`);
    }
    return last;
  }
  return (await response.json()) as JsonRpcResponse;
}

export function callTool(
  name: string,
  args: Record<string, unknown>,
  accessToken: string,
): Promise<JsonRpcResponse> {
  return mcpRequest("tools/call", { name, arguments: args }, accessToken);
}

export function toolResult(response: JsonRpcResponse): Record<string, unknown> {
  if (!response.result) {
    throw new Error(`JSON-RPC request failed: ${JSON.stringify(response.error)}`);
  }
  return response.result;
}

export function toolText(response: JsonRpcResponse): string {
  const content = toolResult(response).content;
  const first = Array.isArray(content) ? content[0] : undefined;
  if (
    !first ||
    typeof first !== "object" ||
    (first as { type?: unknown }).type !== "text" ||
    typeof (first as { text?: unknown }).text !== "string"
  ) {
    throw new Error(`Tool result has no text content: ${JSON.stringify(response)}`);
  }
  return (first as { text: string }).text;
}

export function toolJson(response: JsonRpcResponse): Record<string, unknown> {
  return JSON.parse(toolText(response)) as Record<string, unknown>;
}

export function toolIsError(response: JsonRpcResponse): boolean {
  return response.result?.isError === true;
}

export function toolNames(response: JsonRpcResponse): string[] {
  const tools = toolResult(response).tools;
  if (!Array.isArray(tools)) {
    throw new Error(`tools/list result has no tools array: ${JSON.stringify(response)}`);
  }
  return tools.map((tool) => String((tool as { name?: unknown }).name));
}
