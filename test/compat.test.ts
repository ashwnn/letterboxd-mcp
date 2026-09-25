import { afterEach, describe, expect, it, vi } from "vitest";
import { reset, runInDurableObject } from "cloudflare:test";
import { LETTERBOXD_TOKEN_URL } from "../src/upstream/client";
import { clearResolutionCache } from "../src/upstream/resolve";
import { clearTokenCache, tokenStore } from "../src/upstream/tokens";
import {
  CookieJar,
  PUBLIC_URL,
  ADMIN_PASSWORD,
  callWorker,
  completeOAuthFlow,
  extractHandle,
  form,
  installFetchMock,
  jsonReply,
  linkedStatusRoutes,
  mcpRequest,
  pkcePair,
  seedLinkedMember,
  testEnv,
  toolNames,
} from "./helpers";

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearTokenCache();
  clearResolutionCache();
  await reset();
});

describe("ChatGPT-style CIMD client", () => {
  it("resolves a client_id metadata document and completes the flow", async () => {
    // Unique path per run: the provider caches CIMD documents in a named cache.
    const clientId = `https://claude.ai/.well-known/oauth-client-metadata/${crypto.randomUUID()}`;
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";

    const calls = installFetchMock([
      {
        match: clientId,
        reply: () =>
          jsonReply({
            client_id: clientId,
            client_name: "Claude",
            redirect_uris: [redirectUri],
          }),
      },
      ...linkedStatusRoutes(),
    ]);
    await seedLinkedMember();

    const { verifier, challenge } = await pkcePair();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state: "cimd-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${PUBLIC_URL}/mcp`,
      scope: "letterboxd:read letterboxd:write",
    });

    const page = await callWorker(`/authorize?${params.toString()}`);
    expect(page.status).toBe(200);
    const jar = new CookieJar();
    jar.absorb(page);
    const handle = extractHandle(await page.clone().text());

    const init = form({ handle, password: ADMIN_PASSWORD, decision: "approve" });
    const headers = new Headers(init.headers as Record<string, string>);
    const cookie = jar.header();
    if (cookie) headers.set("cookie", cookie);
    const submit = await callWorker(`/authorize?${params.toString()}`, {
      ...init,
      headers,
    });
    expect(submit.status).toBe(302);
    const location = new URL(submit.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await callWorker(
      "/token",
      form({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${PUBLIC_URL}/mcp`,
      }),
    );
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.clone().json()) as Record<string, unknown>;
    expect(typeof tokenBody.access_token).toBe("string");

    const tools = toolNames(
      await mcpRequest("tools/list", {}, tokenBody.access_token as string),
    );
    expect(tools).toContain("get_diary");
    expect(tools).toContain("log_film");
    expect(calls.calls.some((call) => call.url === clientId)).toBe(true);
  });

  it("rejects a CIMD document whose client_id does not match its URL", async () => {
    const clientId = `https://claude.ai/.well-known/oauth-client-metadata/${crypto.randomUUID()}`;
    installFetchMock([
      {
        match: clientId,
        reply: () =>
          jsonReply({
            client_id: "https://claude.ai/.well-known/oauth-client-metadata/other",
            client_name: "Claude",
            redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          }),
      },
    ]);

    const { challenge } = await pkcePair();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      state: "cimd-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${PUBLIC_URL}/mcp`,
    });
    const response = await callWorker(`/authorize?${params.toString()}`);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("location") ?? "").not.toContain("claude.ai");
  });
});

describe("MCP session lifecycle", () => {
  it("answers initialize for a stateless session", async () => {
    installFetchMock(linkedStatusRoutes());
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });

    const response = await mcpRequest(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "compat-test", version: "0.0.1" },
      },
      flow.accessToken,
    );
    expect(response.error).toBeUndefined();
    const result = response.result ?? {};
    expect(result.protocolVersion).toBeTruthy();
    const serverInfo = result.serverInfo as { name?: string } | undefined;
    expect(serverInfo?.name).toBe("letterboxd-mcp");
  });
});

describe("refresh tokens", () => {
  it("issues a rotated refresh token that can be used again", async () => {
    installFetchMock(linkedStatusRoutes());
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });
    expect(flow.refreshToken).toBeTruthy();

    const first = await callWorker(
      "/token",
      form({
        grant_type: "refresh_token",
        refresh_token: flow.refreshToken ?? "",
        client_id: flow.clientId ?? "",
        client_secret: flow.clientSecret ?? "",
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.clone().json()) as Record<string, unknown>;
    expect(typeof firstBody.access_token).toBe("string");
    expect(typeof firstBody.refresh_token).toBe("string");
    expect(firstBody.refresh_token).not.toBe(flow.refreshToken);

    const second = await callWorker(
      "/token",
      form({
        grant_type: "refresh_token",
        refresh_token: firstBody.refresh_token as string,
        client_id: flow.clientId ?? "",
        client_secret: flow.clientSecret ?? "",
      }),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.clone().json()) as Record<string, unknown>;
    expect(typeof secondBody.access_token).toBe("string");
  });
});

describe("upstream token rotation", () => {
  it("keeps the previous refresh token when Letterboxd omits a new one", async () => {
    installFetchMock([
      {
        match: LETTERBOXD_TOKEN_URL,
        reply: () =>
          jsonReply({
            access_token: "second-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            // No refresh_token: the rotation response must not lose the stored one.
          }),
      },
    ]);

    const stub = tokenStore(testEnv);
    await stub.saveMemberTokens(
      {
        accessToken: "first-access-token",
        refreshToken: "refresh-keep",
        expiresAt: Date.now() - 1_000,
      },
      { id: "2a9q", username: "owner" },
    );
    await clearTokenCache();

    const refreshed = await stub.getToken("member");
    expect(refreshed.token).toBe("second-access-token");

    const stored = await runInDurableObject(stub, async (_instance: unknown, state) =>
      state.storage.get<{ accessToken: string; refreshToken?: string }>("memberTokens"),
    );
    expect(stored?.accessToken).toBe("second-access-token");
    expect(stored?.refreshToken).toBe("refresh-keep");
  });
});
