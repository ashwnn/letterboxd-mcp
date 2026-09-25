import { afterEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import { LETTERBOXD_API } from "../src/upstream/client";
import { clearTokenCache, tokenStore } from "../src/upstream/tokens";
import {
  callTool,
  completeOAuthFlow,
  installFetchMock,
  jsonReply,
  letterboxdRoute,
  linkedStatusRoutes,
  mcpRequest,
  seedLinkedMember,
  testEnv,
  toolIsError,
  toolJson,
  toolText,
} from "./helpers";
import filmFriends from "./fixtures/film-friends.json";
import filmMe from "./fixtures/film-me.json";
import filmParasite from "./fixtures/film-parasite.json";
import filmStatistics from "./fixtures/film-statistics.json";
import filmsRated from "./fixtures/films-rated.json";
import logEntriesPage1 from "./fixtures/log-entries-page1.json";
import logEntryCreated from "./fixtures/log-entry-created.json";
import memberStatistics from "./fixtures/member-statistics.json";
import relationshipUpdate from "./fixtures/relationship-update.json";
import searchParasite from "./fixtures/search-parasite.json";

const READ_TOOLS = [
  "find_films",
  "get_diary",
  "get_film",
  "get_following",
  "get_friends_activity",
  "get_friends_on_film",
  "get_log_entry",
  "get_member_stats",
  "get_my_film_status",
  "get_watchlist",
  "search_films",
  "whoami",
];

const WRITE_TOOLS = ["delete_log_entry", "log_film", "set_film_status", "update_log_entry"];

const FILM_ID = "4k3v";

async function purgeCache(...paths: string[]): Promise<void> {
  for (const path of paths) {
    await caches.default.delete(`${LETTERBOXD_API}${path}`);
  }
}

async function writeFlow() {
  installFetchMock(linkedStatusRoutes());
  await seedLinkedMember();
  return await completeOAuthFlow({ scope: "letterboxd:write" });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearTokenCache();
  await reset();
});

describe("tools/list", () => {
  it("publishes the full catalog with read/write annotations", async () => {
    installFetchMock(linkedStatusRoutes());
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read letterboxd:write" });

    const listed = (await mcpRequest("tools/list", {}, flow.accessToken)).result ?? {};
    const tools = listed.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
    );
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} has annotations`).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(
        READ_TOOLS.includes(tool.name),
      );
    }
  });
});

describe("read tools", () => {
  it("whoami reports the linked member and counts", async () => {
    installFetchMock([
      ...linkedStatusRoutes(),
      letterboxdRoute(`/member/2a9q/statistics`, memberStatistics),
    ]);
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });

    const response = await callTool("whoami", {}, flow.accessToken);
    expect(toolIsError(response)).toBe(false);
    const body = toolJson(response);
    expect(body.linked).toBe(true);
    expect(body.username).toBe("owner");
    expect(body.memberId).toBe("2a9q");
    expect(body.counts).toBeTruthy();
  });

  it("search_films returns film briefs", async () => {
    installFetchMock([...linkedStatusRoutes(), letterboxdRoute("/search", searchParasite)]);
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });

    const body = toolJson(await callTool("search_films", { query: "parasite" }, flow.accessToken));
    const items = body.items as Array<Record<string, unknown>>;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0])).toContain("Parasite");
  });

  it("get_film returns details and statistics", async () => {
    await purgeCache(`/film/${FILM_ID}`, `/film/${FILM_ID}/statistics`);
    installFetchMock([
      ...linkedStatusRoutes(),
      letterboxdRoute(`/film/${FILM_ID}`, filmParasite),
      letterboxdRoute(`/film/${FILM_ID}/statistics`, filmStatistics),
      letterboxdRoute(`/film/${FILM_ID}/me`, filmMe),
      letterboxdRoute("/films", { items: [filmParasite], next: null }),
    ]);
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });

    const response = await callTool("get_film", { film: FILM_ID }, flow.accessToken);
    expect(toolIsError(response)).toBe(false);
    const text = JSON.stringify(toolJson(response));
    expect(text).toContain("Parasite");
    expect(text).toContain("Bong Joon-ho");
    expect(text).toContain("892341");
  });

  it("get_diary returns formatted diary entries", async () => {
    installFetchMock([
      ...linkedStatusRoutes(),
      letterboxdRoute("/log-entries", { ...logEntriesPage1, next: null }),
    ]);
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });

    const body = toolJson(await callTool("get_diary", {}, flow.accessToken));
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.rating).toBe(4.5);
    expect(JSON.stringify(items[0])).toContain("Parasite");
  });

  it("get_friends_activity returns friend entries", async () => {
    installFetchMock([
      ...linkedStatusRoutes(),
      letterboxdRoute("/log-entries", { ...logEntriesPage1, next: null }),
    ]);
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });

    const body = toolJson(await callTool("get_friends_activity", {}, flow.accessToken));
    expect(Array.isArray(body.items)).toBe(true);
    expect((body.items as unknown[]).length).toBeGreaterThan(0);
  });

  it("get_friends_on_film returns friend relationships", async () => {
    installFetchMock([
      ...linkedStatusRoutes(),
      letterboxdRoute(`/film/${FILM_ID}/friends`, filmFriends),
    ]);
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });

    const body = toolJson(
      await callTool("get_friends_on_film", { film: FILM_ID }, flow.accessToken),
    );
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]?.rating).toBe(5);
    expect(body.averageRating).toBe(4.5);
  });

  it("get_watchlist returns film briefs", async () => {
    installFetchMock([
      ...linkedStatusRoutes(),
      letterboxdRoute("/member/2a9q/watchlist", filmsRated),
    ]);
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });

    const body = toolJson(await callTool("get_watchlist", {}, flow.accessToken));
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0])).toContain("Parasite");
  });
});

describe("write tools", () => {
  it("set_film_status patches only the provided fields", async () => {
    const flow = await writeFlow();
    const calls = installFetchMock([
      ...linkedStatusRoutes(),
      {
        method: "PATCH",
        match: new RegExp(`/api/v0/film/${FILM_ID}/me$`),
        reply: () => jsonReply(relationshipUpdate),
      },
    ]);

    const response = await callTool(
      "set_film_status",
      { film: FILM_ID, rating: 4.5, inWatchlist: false },
      flow.accessToken,
    );
    expect(toolIsError(response)).toBe(false);

    const patches = calls.calls.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ rating: 4.5, inWatchlist: false });

    const body = toolJson(response);
    expect(JSON.stringify(body)).toContain('"inWatchlist":false');
    expect(JSON.stringify(body)).toContain("4.5");
  });


  it("delete_log_entry refuses to run without confirm: true", async () => {
    const flow = await writeFlow();
    const calls = installFetchMock([...linkedStatusRoutes()]);

    const response = await callTool("delete_log_entry", { id: "entry-1" }, flow.accessToken);
    expect(response.error !== undefined || toolIsError(response)).toBe(true);
    expect(calls.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("log_film reports an existing diary entry instead of posting a duplicate", async () => {
    const flow = await writeFlow();
    const calls = installFetchMock([
      ...linkedStatusRoutes(),
      {
        method: "GET",
        match: /^https:\/\/api\.letterboxd\.com\/api\/v0\/log-entries(\?|$)/,
        reply: () => jsonReply({ ...logEntriesPage1, next: null }),
      },
      {
        method: "POST",
        match: /^https:\/\/api\.letterboxd\.com\/api\/v0\/log-entries$/,
        reply: () => jsonReply(logEntryCreated, 201),
      },
    ]);

    const response = await callTool(
      "log_film",
      { film: FILM_ID, watchedOn: "2024-03-15" },
      flow.accessToken,
    );
    expect(toolIsError(response)).toBe(false);
    const body = toolJson(response);
    expect(body.duplicate).toBe(true);
    expect(body.existingEntryId).toBe("entry-1");
    expect(calls.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("log_film posts a new diary entry when there is no duplicate", async () => {
    const flow = await writeFlow();
    const calls = installFetchMock([
      ...linkedStatusRoutes(),
      {
        method: "GET",
        match: /^https:\/\/api\.letterboxd\.com\/api\/v0\/log-entries(\?|$)/,
        reply: () => jsonReply({ ...logEntriesPage1, next: null }),
      },
      {
        method: "POST",
        match: /^https:\/\/api\.letterboxd\.com\/api\/v0\/log-entries$/,
        reply: () => jsonReply(logEntryCreated, 201),
      },
    ]);

    const response = await callTool(
      "log_film",
      { film: FILM_ID, watchedOn: "2024-04-01", rating: 4, liked: true },
      flow.accessToken,
    );
    expect(toolIsError(response)).toBe(false);
    const posts = calls.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({
      filmId: FILM_ID,
      diaryDetails: { diaryDate: "2024-04-01" },
      rating: 4,
      like: true,
    });
  });
});

describe("unlinked Letterboxd", () => {
  it("tells the user to relink when a member token is required", async () => {
    const flow = await writeFlow();
    await tokenStore(testEnv).unlink();
    await clearTokenCache();
    installFetchMock([]);

    const response = await callTool("get_diary", {}, flow.accessToken);
    expect(toolIsError(response)).toBe(true);
    expect(toolText(response)).toContain("/letterboxd/relink");
  });
});
