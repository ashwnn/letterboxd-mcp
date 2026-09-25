import { afterEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import { LETTERBOXD_TOKEN_URL } from "../src/upstream/client";
import { clearTokenCache, tokenStore } from "../src/upstream/tokens";
import {
  PUBLIC_URL,
  beginAuthorize,
  callWorker,
  completeOAuthFlow,
  exchangeCode,
  installFetchMock,
  jsonReply,
  letterboxdRoute,
  linkedStatusRoutes,
  mcpRequest,
  registerClient,
  seedLinkedMember,
  testEnv,
  toolNames,
} from "./helpers";
import me from "./fixtures/me.json";
import tokenResponse from "./fixtures/token-response.json";

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearTokenCache();
  await reset();
});

describe("OAuth metadata", () => {
  it("advertises PKCE, CIMD, and both Letterboxd scopes", async () => {
    const response = await callWorker("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.scopes_supported).toEqual(
      expect.arrayContaining(["letterboxd:read", "letterboxd:write"]),
    );
  });

  it("publishes protected resource metadata naming the /mcp resource", async () => {
    const response = await callWorker("/.well-known/oauth-protected-resource/mcp");
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.resource).toBe(`${PUBLIC_URL}/mcp`);
    expect(metadata.authorization_servers).toContain(PUBLIC_URL);
  });

  it("challenges unauthenticated /mcp requests with the resource metadata URL", async () => {
    const response = await callWorker("/mcp");
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain("/.well-known/oauth-protected-resource");
  });
});

describe("authorize endpoint", () => {
  it("refuses a client whose redirect host is not allowlisted", async () => {
    installFetchMock([]);
    const registration = await registerClient("https://evil.example/cb", "Evil Client");

    if (registration.response.status === 201 && registration.clientId) {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: registration.clientId,
        redirect_uri: "https://evil.example/cb",
        state: "test-state",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
        resource: `${PUBLIC_URL}/mcp`,
      });
      const response = await callWorker(`/authorize?${params.toString()}`);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("location") ?? "").not.toContain("evil.example");
    } else {
      expect(registration.response.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("rejects a wrong password without redirecting to the client", async () => {
    installFetchMock([]);
    const start = await beginAuthorize({
      password: "definitely-not-the-password",
      ip: "203.0.113.10",
    });
    expect(start.submit.status).toBe(401);
    expect(start.submit.headers.get("location") ?? "").not.toContain("claude.ai");
    expect(await start.submit.clone().text()).toContain("Incorrect password");
  });

  it("rate limits repeated failed logins from the same IP", async () => {
    installFetchMock([]);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const start = await beginAuthorize({
        password: "definitely-not-the-password",
        ip: "203.0.113.20",
      });
      statuses.push(start.submit.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});

describe("authorization code flow", () => {
  it("issues a code and exchanges it with the correct PKCE verifier", async () => {
    installFetchMock(linkedStatusRoutes());
    await seedLinkedMember();

    const flow = await completeOAuthFlow({ scope: "letterboxd:read letterboxd:write" });
    expect(flow.submit.status).toBe(302);
    const redirect = new URL(flow.submit.headers.get("location") ?? "");
    expect(`${redirect.origin}${redirect.pathname}`).toBe("https://claude.ai/callback");
    expect(redirect.searchParams.get("code")).toBe(flow.code);
    expect(flow.redirectUri).toBe("https://claude.ai/callback");
    expect(flow.accessToken).toBeTruthy();
    expect(flow.refreshToken).toBeTruthy();
  });

  it("rejects a token exchange with the wrong PKCE verifier", async () => {
    installFetchMock(linkedStatusRoutes());
    await seedLinkedMember();

    const start = await beginAuthorize({ scope: "letterboxd:read" });
    const code = new URL(start.submit.headers.get("location") ?? "").searchParams.get("code");
    expect(code).toBeTruthy();

    const response = await exchangeCode(start, code ?? "", {
      code_verifier: "not-the-right-verifier",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_grant");
  });

  it("rejects a token exchange bound to a different resource", async () => {
    installFetchMock(linkedStatusRoutes());
    await seedLinkedMember();

    const start = await beginAuthorize({ scope: "letterboxd:read" });
    const code = new URL(start.submit.headers.get("location") ?? "").searchParams.get("code");
    expect(code).toBeTruthy();

    const response = await exchangeCode(start, code ?? "", {
      resource: "https://someone-else.example/mcp",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_target");
  });

  it("gates write tools on the granted scope", async () => {
    installFetchMock(linkedStatusRoutes());
    await seedLinkedMember();

    const readFlow = await completeOAuthFlow({ scope: "letterboxd:read" });
    const readTools = toolNames(await mcpRequest("tools/list", {}, readFlow.accessToken));
    expect(readTools).toContain("get_diary");
    expect(readTools).not.toContain("log_film");

    const writeFlow = await completeOAuthFlow({ scope: "letterboxd:write" });
    const writeTools = toolNames(await mcpRequest("tools/list", {}, writeFlow.accessToken));
    expect(writeTools).toContain("log_film");
  });
});

describe("Letterboxd linking", () => {
  it("redirects to Letterboxd and completes the link at the callback", async () => {
    const calls = installFetchMock([
      { match: LETTERBOXD_TOKEN_URL, reply: () => jsonReply(tokenResponse) },
      letterboxdRoute("/me", me),
    ]);

    const start = await beginAuthorize();
    expect(start.submit.status).toBe(302);

    const upstream = new URL(start.submit.headers.get("location") ?? "");
    expect(`${upstream.origin}${upstream.pathname}`).toBe(
      "https://api.letterboxd.com/api/v0/auth/authorize",
    );
    expect(upstream.searchParams.get("client_id")).toBe("test-client-id");
    const state = upstream.searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = await callWorker(
      `/letterboxd/callback?code=test-code&state=${state ?? ""}`,
      { headers: { cookie: start.jar.header() ?? "" } },
    );
    expect(callback.status).toBe(302);
    const redirect = new URL(callback.headers.get("location") ?? "");
    expect(`${redirect.origin}${redirect.pathname}`).toBe("https://claude.ai/callback");
    expect(redirect.searchParams.get("code")).toBeTruthy();

    const status = await tokenStore(testEnv).status();
    expect(status.linked).toBe(true);
    expect(status.broken).toBe(false);
    expect(status.username).toBe("owner");
    expect(calls.calls.some((call) => call.url === LETTERBOXD_TOKEN_URL)).toBe(true);
  });

  it("rejects a callback with a foreign state and does not exchange tokens", async () => {
    const calls = installFetchMock([]);
    const response = await callWorker(
      "/letterboxd/callback?code=test-code&state=forged-state",
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("location") ?? "").not.toContain("claude.ai");
    expect(calls.calls).toHaveLength(0);

    const status = await tokenStore(testEnv).status();
    expect(status.linked).toBe(false);
  });
});
