import { afterEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import {
  LETTERBOXD_TOKEN_URL,
  LetterboxdApiError,
  lbPaginate,
  lbRequest,
} from "../src/upstream/client";
import { clearTokenCache } from "../src/upstream/tokens";
import { clearResolutionCache, resolveFilmId, resolveMemberId } from "../src/upstream/resolve";
import { toDiaryEntry, toFilmBrief, trimReview } from "../src/upstream/format";
import {
  installFetchMock,
  jsonReply,
  letterboxdRoute,
  seedLinkedMember,
  testEnv,
  tokenRoute,
} from "./helpers";
import error404 from "./fixtures/error-404.json";
import filmParasite from "./fixtures/film-parasite.json";
import logEntriesPage1 from "./fixtures/log-entries-page1.json";
import logEntriesPage2 from "./fixtures/log-entries-page2.json";
import tokenResponse from "./fixtures/token-response.json";

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearTokenCache();
  clearResolutionCache();
  await reset();
});

describe("lbRequest", () => {
  it("explodes array query values into repeated parameters", async () => {
    const calls = installFetchMock([
      tokenRoute(),
      letterboxdRoute("/films", { items: [], next: null }),
    ]);
    await lbRequest(testEnv, "GET", "/films", {
      query: { filmId: ["imdb:tt6751668", "tmdb:496243"], perPage: 2 },
      auth: "any",
    });
    const call = calls.calls.find((entry) => entry.url.includes("/api/v0/films"));
    expect(call).toBeTruthy();
    const url = new URL(call?.url ?? "");
    expect(url.searchParams.getAll("filmId")).toEqual(["imdb:tt6751668", "tmdb:496243"]);
    expect(url.searchParams.get("perPage")).toBe("2");
  });

  it("refreshes once and retries after a 401", async () => {
    await seedLinkedMember();
    let attempts = 0;
    const calls = installFetchMock([
      tokenRoute({ ...tokenResponse, access_token: "refreshed-token" }),
      {
        match: /\/api\/v0\/film\/4k3v$/,
        reply: () => {
          attempts += 1;
          return attempts === 1
            ? jsonReply({ error: true, message: "Unauthorized", code: "unauthorized" }, 401)
            : jsonReply(filmParasite);
        },
      },
    ]);

    const film = await lbRequest<{ name: string }>(testEnv, "GET", "/film/4k3v", {
      auth: "member",
    });
    expect(film.name).toBe("Parasite");
    expect(attempts).toBe(2);
    expect(
      calls.calls.filter((call) => call.url.startsWith(LETTERBOXD_TOKEN_URL)),
    ).toHaveLength(1);
  });

  it("retries a 429 response after Retry-After", async () => {
    await seedLinkedMember();
    let attempts = 0;
    installFetchMock([
      tokenRoute(),
      {
        match: /\/api\/v0\/film\/4k3v$/,
        reply: () => {
          attempts += 1;
          return attempts === 1
            ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
            : jsonReply(filmParasite);
        },
      },
    ]);

    const film = await lbRequest<{ name: string }>(testEnv, "GET", "/film/4k3v", {
      auth: "member",
    });
    expect(film.name).toBe("Parasite");
    expect(attempts).toBe(2);
  });

  it("maps an API error body to LetterboxdApiError", async () => {
    installFetchMock([
      tokenRoute(),
      { match: /\/api\/v0\/film\/missing$/, reply: () => jsonReply(error404, 404) },
    ]);
    const error: unknown = await lbRequest(testEnv, "GET", "/film/missing", {
      auth: "any",
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LetterboxdApiError);
    expect((error as LetterboxdApiError).status).toBe(404);
    expect((error as Error).message).toContain("No film matches the specified ID");
  });

  it("caches public GET responses with cacheTtl", async () => {
    const calls = installFetchMock([
      tokenRoute(),
      letterboxdRoute("/films/4k3v", filmParasite),
    ]);
    const target = "https://api.letterboxd.com/api/v0/films/4k3v";
    await caches.default.delete(target);

    await lbRequest(testEnv, "GET", "/films/4k3v", { auth: "any", cacheTtl: 3600 });
    await lbRequest(testEnv, "GET", "/films/4k3v", { auth: "any", cacheTtl: 3600 });

    expect(
      calls.calls.filter((call) => call.url.startsWith(target)),
    ).toHaveLength(1);
  });
});

describe("lbPaginate", () => {
  it("follows next cursors across pages", async () => {
    installFetchMock([
      tokenRoute(),
      { match: /[?&]cursor=/, reply: () => jsonReply(logEntriesPage2) },
      letterboxdRoute("/log-entries", logEntriesPage1),
    ]);

    const page = await lbPaginate<{ id: string }>(testEnv, "/log-entries", {}, { auth: "any" });
    expect(page.items.map((item) => item.id)).toEqual(["entry-1", "entry-2"]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("resolveFilmId", () => {
  it("passes through tmdb and boxd.it ids, looks up imdb ids, and HEADs film pages", async () => {
    const calls = installFetchMock([
      tokenRoute(),
      letterboxdRoute("/films", { items: [filmParasite], next: null }),
      {
        method: "HEAD",
        match: "https://letterboxd.com/film/parasite-2019/",
        reply: () =>
          new Response(null, {
            status: 200,
            headers: { "x-letterboxd-identifier": "4k3v" },
          }),
      },
      {
        method: "HEAD",
        match: (url) => url.hostname === "boxd.it",
        reply: () =>
          new Response(null, {
            status: 200,
            headers: { "x-letterboxd-identifier": "abc" },
          }),
      },
    ]);

    expect(await resolveFilmId(testEnv, "tmdb:496243")).toBe("tmdb:496243");
    expect(await resolveFilmId(testEnv, "imdb:tt6751668")).toBe("4k3v");
    expect(await resolveFilmId(testEnv, "https://boxd.it/abc")).toBe("abc");
    expect(await resolveFilmId(testEnv, "https://letterboxd.com/film/parasite-2019/")).toBe(
      "4k3v",
    );

    expect(
      calls.calls.filter((call) => call.url.includes("/api/v0/films")),
    ).toHaveLength(1);
    expect(
      calls.calls.filter(
        (call) =>
          call.method === "HEAD" && call.url.includes("letterboxd.com/film/parasite-2019"),
      ),
    ).toHaveLength(1);
  });

  it("caches resolution in LOOKUP_KV so the second call makes no request", async () => {
    const calls = installFetchMock([
      tokenRoute(),
      {
        method: "HEAD",
        match: "https://letterboxd.com/film/parasite-2019/",
        reply: () =>
          new Response(null, {
            status: 200,
            headers: { "x-letterboxd-identifier": "4k3v" },
          }),
      },
    ]);

    await resolveFilmId(testEnv, "https://letterboxd.com/film/parasite-2019/");
    const headCalls = calls.calls.filter((call) => call.method === "HEAD").length;
    await resolveFilmId(testEnv, "https://letterboxd.com/film/parasite-2019/");

    expect(calls.calls.filter((call) => call.method === "HEAD")).toHaveLength(headCalls);
    const keys = await testEnv.LOOKUP_KV.list();
    expect(keys.keys.length).toBeGreaterThan(0);
  });
});

describe("resolveMemberId", () => {
  it("resolves the linked member and HEADs usernames", async () => {
    await seedLinkedMember();
    const calls = installFetchMock([
      tokenRoute(),
      {
        method: "HEAD",
        match: (url) =>
          url.origin === "https://letterboxd.com" && url.pathname.startsWith("/owner"),
        reply: () =>
          new Response(null, {
            status: 200,
            headers: { "x-letterboxd-identifier": "2a9q" },
          }),
      },
    ]);

    expect(await resolveMemberId(testEnv)).toBe("2a9q");
    expect(await resolveMemberId(testEnv, "me")).toBe("2a9q");
    expect(await resolveMemberId(testEnv, "owner")).toBe("2a9q");
    expect(calls.calls.filter((call) => call.method === "HEAD")).toHaveLength(1);
  });
});

describe("format", () => {
  it("builds a compact film brief", () => {
    const brief = toFilmBrief(filmParasite as never);
    expect(brief).toMatchObject({ id: "4k3v", title: "Parasite" });
    expect(JSON.stringify(brief)).toContain("Bong Joon-ho");
    expect(JSON.stringify(brief)).toContain("letterboxd.com");
  });

  it("builds a diary entry with a numeric rating", () => {
    const entry = toDiaryEntry(logEntriesPage1.items[0] as never);
    expect(entry).toMatchObject({ id: "entry-1", rating: 4.5 });
    expect(JSON.stringify(entry)).toContain("2024-03-15");
  });

  it("trims long reviews to the default 600 character budget", () => {
    const short = trimReview("A short review.");
    expect(short.text).toBe("A short review.");
    expect(short.truncated).toBe(false);

    const long = trimReview("x".repeat(700));
    expect(long.text?.length).toBeLessThanOrEqual(600);
    expect(long.text).not.toBe("x".repeat(700));
    expect(long.text?.startsWith("xxx")).toBe(true);
    expect(long.truncated).toBe(true);
  });
});
