import { afterEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import type { Env } from "../src/env";
import { grantedScopes, isReadOnly } from "../src/env";
import { LETTERBOXD_API, LETTERBOXD_TOKEN_URL } from "../src/upstream/client";
import { clearResolutionCache } from "../src/upstream/resolve";
import { clearTokenCache, tokenStore } from "../src/upstream/tokens";
import {
  ADMIN_PASSWORD,
  CookieJar,
  callTool,
  callWorker,
  completeOAuthFlow,
  form,
  installFetchMock,
  jsonReply,
  letterboxdRoute,
  linkedStatusRoutes,
  seedLinkedMember,
  testEnv,
  toolIsError,
  toolText,
} from "./helpers";
import filmParasite from "./fixtures/film-parasite.json";
import filmStatistics from "./fixtures/film-statistics.json";
import logEntriesPage1 from "./fixtures/log-entries-page1.json";
import me from "./fixtures/me.json";
import tokenResponse from "./fixtures/token-response.json";

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearTokenCache();
  clearResolutionCache();
  await reset();
});

describe("scope gating", () => {
  it("grants read and write normally, and suppresses write under READ_ONLY", () => {
    const open = testEnv;
    expect(grantedScopes(open, ["letterboxd:read", "letterboxd:write"])).toEqual([
      "letterboxd:read",
      "letterboxd:write",
    ]);
    expect(grantedScopes(open, [])).toEqual(["letterboxd:read", "letterboxd:write"]);

    const readOnly = { ...open, READ_ONLY: "true" } as Env;
    expect(isReadOnly(readOnly)).toBe(true);
    expect(grantedScopes(readOnly, ["letterboxd:read", "letterboxd:write"])).toEqual([
      "letterboxd:read",
    ]);
  });
});

describe("relink", () => {
  it("starts a signed relink and completes it at the callback", async () => {
    const calls = installFetchMock([
      { match: LETTERBOXD_TOKEN_URL, reply: () => jsonReply(tokenResponse) },
      letterboxdRoute("/me", me),
    ]);

    const start = await callWorker(
      "/letterboxd/relink",
      form({ password: ADMIN_PASSWORD }),
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://api.letterboxd.com/api/v0/auth/authorize",
    );
    const state = location.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(0);

    const jar = new CookieJar();
    jar.absorb(start);
    expect(jar.header()).toBeTruthy();

    const callback = await callWorker(
      `/letterboxd/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: jar.header() ?? "" } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/?linked=1");

    const status = await tokenStore(testEnv).status();
    expect(status.linked).toBe(true);
    expect(status.username).toBe("owner");
    expect(calls.calls.filter((call) => call.url === LETTERBOXD_TOKEN_URL)).toHaveLength(1);
  });

  it("refuses a callback whose relink cookie does not match the state", async () => {
    const calls = installFetchMock([
      { match: LETTERBOXD_TOKEN_URL, reply: () => jsonReply(tokenResponse) },
      letterboxdRoute("/me", me),
    ]);

    const start = await callWorker(
      "/letterboxd/relink",
      form({ password: ADMIN_PASSWORD }),
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

    const forged = await callWorker(
      `/letterboxd/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: "__Host-lb-relink=forged-signature" } },
    );
    expect(forged.status).toBe(400);

    const missing = await callWorker(
      `/letterboxd/callback?code=test-code&state=${encodeURIComponent(state)}`,
    );
    expect(missing.status).toBe(400);

    expect(calls.calls.filter((call) => call.url === LETTERBOXD_TOKEN_URL)).toHaveLength(0);
    expect((await tokenStore(testEnv).status()).linked).toBe(false);
  });
});

describe("unlink", () => {
  it("removes the stored link after a correct password", async () => {
    installFetchMock([]);
    await seedLinkedMember();

    const response = await callWorker(
      "/letterboxd/unlink",
      form({ password: ADMIN_PASSWORD }),
    );
    expect(response.status).toBe(302);
    const status = await tokenStore(testEnv).status();
    expect(status.linked).toBe(false);
  });

  it("rejects a wrong password without unlinking", async () => {
    installFetchMock([]);
    await seedLinkedMember();

    const response = await callWorker(
      "/letterboxd/unlink",
      form({ password: "nope" }),
    );
    expect(response.status).toBe(401);
    expect((await tokenStore(testEnv).status()).linked).toBe(true);
  });
});

describe("film id handling", () => {
  it("passes tmdb: ids through unencoded", async () => {
    installFetchMock(linkedStatusRoutes());
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });

    const calls = installFetchMock([
      ...linkedStatusRoutes(),
      { match: `${LETTERBOXD_API}/film/tmdb:496243`, reply: () => jsonReply(filmParasite) },
      {
        match: `${LETTERBOXD_API}/film/tmdb:496243/statistics`,
        reply: () => jsonReply(filmStatistics),
      },
      {
        match: `${LETTERBOXD_API}/film/tmdb:496243/me`,
        reply: () => jsonReply({ data: { watched: true, rating: 4.5 } }),
      },
    ]);

    const response = await callTool("get_film", { film: "tmdb:496243" }, flow.accessToken);
    expect(toolIsError(response)).toBe(false);
    expect(
      calls.calls.some((call) => call.url === `${LETTERBOXD_API}/film/tmdb:496243`),
    ).toBe(true);
    expect(calls.calls.some((call) => call.url.includes("%3A"))).toBe(false);
  });
});

describe("write validation", () => {
  async function writeFlow() {
    installFetchMock(linkedStatusRoutes());
    await seedLinkedMember();
    return completeOAuthFlow({ scope: "letterboxd:write" });
  }

  it("rejects a future diary date before any write", async () => {
    const flow = await writeFlow();
    const calls = installFetchMock([...linkedStatusRoutes()]);

    const response = await callTool(
      "log_film",
      { film: "4k3v", watchedOn: "2999-01-01" },
      flow.accessToken,
    );
    expect(toolIsError(response)).toBe(true);
    expect(toolText(response)).toContain("future");
    expect(calls.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("refuses to update an entry owned by another account", async () => {
    const flow = await writeFlow();
    const foreign = {
      ...logEntriesPage1.items[0],
      id: "entry-foreign",
      owner: { id: "someone-else", username: "not-owner" },
    };
    const calls = installFetchMock([
      ...linkedStatusRoutes(),
      { match: /\/api\/v0\/log-entry\/entry-foreign$/, reply: () => jsonReply(foreign) },
    ]);

    const response = await callTool(
      "update_log_entry",
      { id: "entry-foreign", rating: 5 },
      flow.accessToken,
    );
    expect(toolIsError(response)).toBe(true);
    expect(toolText(response)).toContain("different Letterboxd account");
    expect(calls.calls.some((call) => call.method === "PATCH")).toBe(false);
  });
});
