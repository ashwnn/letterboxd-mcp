import { afterEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import { LETTERBOXD_API } from "../src/upstream/client";
import { fetchMemberIdentity } from "../src/upstream/client";
import { toDiaryEntry, toFilmDetail, toMyFilmStatus } from "../src/upstream/format";
import { clearResolutionCache } from "../src/upstream/resolve";
import { clearTokenCache } from "../src/upstream/tokens";
import {
  callTool,
  completeOAuthFlow,
  installFetchMock,
  jsonReply,
  linkedStatusRoutes,
  seedLinkedMember,
  testEnv,
  toolIsError,
} from "./helpers";

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearTokenCache();
  clearResolutionCache();
  await reset();
});

/**
 * These shapes follow the published Letterboxd API docs: `Film.runTime`,
 * `Film.description`, `contributions[].contributors[]` with `characterName`,
 * `Tag.displayTag`, `ProductionRelationship.productionId` and string-id arrays.
 * The older fixture shapes stay supported too.
 */
describe("documented Letterboxd shapes", () => {
  it("maps a documented Film plus FilmStatistics", () => {
    const film = {
      id: "4k3v",
      name: "Parasite",
      releaseYear: 2019,
      runTime: 132,
      description: "All unemployed, Ki-taek's family takes peculiar interest in the wealthy Parks.",
      tagline: "Act like you own the place.",
      genres: [{ id: "drama", name: "Drama" }],
      countries: [{ name: "South Korea" }],
      languages: [{ name: "Korean" }],
      links: [
        { type: "letterboxd", id: "4k3v", url: "https://letterboxd.com/film/parasite-2019/" },
        { type: "tmdb", id: "496243", url: "https://www.themoviedb.org/movie/496243" },
        { type: "imdb", id: "tt6751668", url: "https://www.imdb.com/title/tt6751668/" },
      ],
      contributions: [
        { type: "Director", contributors: [{ id: "1", name: "Bong Joon-ho" }] },
        { type: "Writer", contributors: [{ id: "1", name: "Bong Joon-ho" }] },
        { type: "Actor", contributors: [{ id: "2", name: "Song Kang-ho", characterName: "Kim Ki-taek" }] },
      ],
    };
    const statistics = {
      film: { id: "4k3v" },
      counts: { watches: 892341, likes: 152008, ratings: 480112, fans: 21004, lists: 42031, reviews: 31077 },
      rating: 4.36,
    };

    const detail = toFilmDetail(film, statistics);
    expect(detail.runtimeMinutes).toBe(132);
    expect(detail.synopsis).toContain("Ki-taek");
    expect(detail.directors).toEqual(["Bong Joon-ho"]);
    expect(detail.cast).toEqual([{ name: "Song Kang-ho", character: "Kim Ki-taek" }]);
    expect(detail.crew).toContainEqual({ role: "Writer", names: ["Bong Joon-ho"] });
    expect(detail.tmdbId).toBe("496243");
    expect(detail.imdbId).toBe("tt6751668");
    expect(detail.counts.watches).toBe(892341);
    expect(detail.averageRating).toBe(4.36);
  });

  it("maps a documented FilmLogEntry", () => {
    const entry = {
      id: "entry-1",
      name: "Parasite",
      type: "FilmLogEntry",
      production: { id: "4k3v", name: "Parasite" },
      owner: { id: "2a9q", username: "owner" },
      diaryDetails: { diaryDate: "2024-03-15", rewatch: true },
      review: { text: "Still perfect.", containsSpoilers: false },
      tags2: [
        { code: "thriller", displayTag: "Thriller" },
        { code: "korean-cinema", displayTag: "Korean Cinema" },
      ],
      rating: 4.5,
      like: true,
      whenCreated: "2024-03-16T04:20:00.000Z",
      links: [
        { type: "letterboxd", id: "entry-1", url: "https://letterboxd.com/owner/film/parasite-2019/" },
      ],
    };

    const diary = toDiaryEntry(entry);
    expect(diary.film.id).toBe("4k3v");
    expect(diary.watchedOn).toBe("2024-03-15");
    expect(diary.rewatch).toBe(true);
    expect(diary.rating).toBe(4.5);
    expect(diary.tags).toEqual(["Thriller", "Korean Cinema"]);
    expect(diary.review).toBe("Still perfect.");
  });

  it("maps a documented ProductionRelationship", () => {
    const relationship = {
      type: "Film",
      productionId: "4k3v",
      memberId: "2a9q",
      watched: true,
      liked: true,
      favorited: false,
      inWatchlist: false,
      rating: 4.5,
      diaryEntries: ["entry-1"],
      reviews: ["review-1"],
    };

    const status = toMyFilmStatus({ id: "4k3v" }, relationship);
    expect(status.film.id).toBe("4k3v");
    expect(status.watched).toBe(true);
    expect(status.liked).toBe(true);
    expect(status.inWatchlist).toBe(false);
    expect(status.rating).toBe(4.5);
    expect(status.diaryEntryIds).toEqual(["entry-1"]);
    expect(status.reviewIds).toEqual(["review-1"]);
  });

  it("accepts /me identity both nested and top-level", async () => {
    const nested = installFetchMock([
      { match: `${LETTERBOXD_API}/me`, reply: () => jsonReply({ member: { id: "2a9q", username: "owner" } }) },
    ]);
    expect(await fetchMemberIdentity(testEnv, "token")).toEqual({
      id: "2a9q",
      username: "owner",
      displayName: undefined,
    });
    expect(nested.calls).toHaveLength(1);

    installFetchMock([
      {
        match: `${LETTERBOXD_API}/me`,
        reply: () => jsonReply({ id: "2a9q", username: "owner", displayName: "Owner" }),
      },
    ]);
    expect(await fetchMemberIdentity(testEnv, "token")).toEqual({
      id: "2a9q",
      username: "owner",
      displayName: "Owner",
    });
  });

  it("filters diary entries with the documented `film` parameter", async () => {
    installFetchMock(linkedStatusRoutes());
    await seedLinkedMember();
    const flow = await completeOAuthFlow({ scope: "letterboxd:read" });

    const calls = installFetchMock([
      ...linkedStatusRoutes(),
      { match: /\/api\/v0\/log-entries(\?|$)/, reply: () => jsonReply({ items: [], next: null }) },
    ]);

    const response = await callTool(
      "get_diary",
      { film: "4k3v", minRating: 3, maxRating: 5 },
      flow.accessToken,
    );
    expect(toolIsError(response)).toBe(false);

    const call = calls.calls.find((entry) => entry.url.includes("/log-entries?"));
    expect(call).toBeTruthy();
    const url = new URL(call?.url ?? "");
    expect(url.searchParams.get("film")).toBe("4k3v");
    expect(url.searchParams.has("filmId")).toBe(false);
    expect(url.searchParams.get("minRating")).toBe("3");
    expect(url.searchParams.get("maxRating")).toBe("5");
  });
});
