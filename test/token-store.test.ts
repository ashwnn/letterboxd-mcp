import { afterEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import { LetterboxdNotLinkedError, LETTERBOXD_TOKEN_URL } from "../src/upstream/client";
import { clearTokenCache, getToken, tokenStore } from "../src/upstream/tokens";
import { installFetchMock, jsonReply, seedLinkedMember, testEnv } from "./helpers";
import tokenResponse from "./fixtures/token-response.json";

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearTokenCache();
  await reset();
});

describe("LetterboxdTokenStore", () => {
  it("returns the seeded member access token", async () => {
    installFetchMock([]);
    await seedLinkedMember();
    expect(await getToken(testEnv, "member")).toBe("member-token");
  });

  it("refreshes an expiring member token exactly once under concurrency", async () => {
    const calls = installFetchMock([
      {
        match: LETTERBOXD_TOKEN_URL,
        reply: () =>
          jsonReply({ ...tokenResponse, access_token: "refreshed-token", refresh_token: "refresh-2" }),
      },
    ]);
    await seedLinkedMember({ expiresAt: Date.now() + 30_000 });

    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => getToken(testEnv, "member")),
    );

    expect(tokens).toEqual(Array.from({ length: 5 }, () => "refreshed-token"));
    const tokenCalls = calls.calls.filter((call) => call.url.startsWith(LETTERBOXD_TOKEN_URL));
    expect(tokenCalls).toHaveLength(1);
  });

  it("marks the link broken when the refresh token is rejected", async () => {
    installFetchMock([
      {
        match: LETTERBOXD_TOKEN_URL,
        reply: () =>
          jsonReply({ error: "invalid_grant", error_description: "refresh token revoked" }, 400),
      },
    ]);
    await seedLinkedMember({ expiresAt: Date.now() - 1_000 });

    await expect(getToken(testEnv, "member")).rejects.toBeInstanceOf(LetterboxdNotLinkedError);
    const status = await tokenStore(testEnv).status();
    expect(status.broken).toBe(true);
    await expect(getToken(testEnv, "member")).rejects.toBeInstanceOf(LetterboxdNotLinkedError);
  });

  it("falls back to a cached client-credentials token when no member is linked", async () => {
    const calls = installFetchMock([
      {
        match: LETTERBOXD_TOKEN_URL,
        reply: () =>
          jsonReply({
            access_token: "app-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "public",
          }),
      },
    ]);

    expect(await getToken(testEnv, "any")).toBe("app-token");
    expect(await getToken(testEnv, "any")).toBe("app-token");

    const tokenCalls = calls.calls.filter((call) => call.url.startsWith(LETTERBOXD_TOKEN_URL));
    expect(tokenCalls).toHaveLength(1);
    expect(String(tokenCalls[0]?.body ?? "")).toContain("client_credentials");
  });

  it("clears the link on unlink", async () => {
    installFetchMock([]);
    await seedLinkedMember();

    await tokenStore(testEnv).unlink();
    await clearTokenCache();

    const status = await tokenStore(testEnv).status();
    expect(status.linked).toBe(false);
    await expect(getToken(testEnv, "member")).rejects.toBeInstanceOf(LetterboxdNotLinkedError);
  });
});
