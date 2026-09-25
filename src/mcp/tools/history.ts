import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../../env";
import { LetterboxdApiError, lbRequest } from "../../upstream/client";
import { toDiaryEntry, toFilmBrief } from "../../upstream/format";
import { resolveFilmId, resolveMemberId } from "../../upstream/resolve";
import { tokenStore } from "../../upstream/tokens";
import {
  asParam,
  asRecords,
  isRecord,
  makeGuard,
  requestPage,
  type ListResult,
  type Query,
  type ToolDeps,
} from "../handler";

const ratingSchema = z.number().min(0.5).max(5).multipleOf(0.5);

const DIARY_SORTS: Record<string, string> = {
  newest: "Date",
  oldest: "DateEarliestFirst",
  highestRated: "RatingHighToLow",
  lowestRated: "RatingLowToHigh",
  recentlyAdded: "WhenAdded",
};

const FILM_RELATIONSHIPS: Record<string, string> = {
  watched: "Watched",
  liked: "Liked",
  rated: "Rated",
  watchlist: "InWatchlist",
};

const FILM_SORTS: Record<string, string> = {
  myRatingHigh: "MemberRatingHighToLow",
  myRatingLow: "MemberRatingLowToHigh",
  dateLatest: "DateLatestFirst",
  dateEarliest: "DateEarliestFirst",
  releaseNewest: "ReleaseDateLatestFirst",
  releaseOldest: "ReleaseDateEarliestFirst",
  popular: "FilmPopularity",
  averageRatingHigh: "AverageRatingHighToLow",
  shortest: "FilmDurationShortestFirst",
  longest: "FilmDurationLongestFirst",
};

const MEMBER = z
  .string()
  .optional()
  .describe("Letterboxd username or member id; defaults to the linked account");
const PER_PAGE_20 = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20)
  .describe("Items per page (1-100, default 20)");
const CURSOR = z.string().optional().describe("Pagination cursor from a previous response");

const toEntry = (raw: Record<string, unknown>) =>
  toDiaryEntry(asParam<Parameters<typeof toDiaryEntry>[0]>(raw));
const toBrief = (raw: Record<string, unknown>) =>
  toFilmBrief(asParam<Parameters<typeof toFilmBrief>[0]>(raw));

const briefPage = (page: ListResult<Record<string, unknown>>) => ({
  items: page.items.map(toBrief),
  nextCursor: page.nextCursor,
  count: page.items.length,
  truncated: page.truncated,
});

// Real API counts use "watches"/"ratings"/...; older shapes used "filmsWatched"/... .
const COUNT_FIELDS = [
  "watches",
  "ratings",
  "reviews",
  "diaryEntries",
  "filmLikes",
  "listLikes",
  "reviewLikes",
  "filmsWatched",
  "filmsRated",
  "filmsLiked",
  "filmsInWatchlist",
];

function pickCounts(stats: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(stats.counts)) return stats.counts;
  const picked: Record<string, unknown> = {};
  for (const key of COUNT_FIELDS) {
    const value = stats[key];
    if (typeof value === "number") picked[key] = value;
  }
  return picked;
}

const STAT_FIELDS = [
  "member",
  "counts",
  "ratingsHistogram",
  "ratingHistogram",
  "yearsInReview",
  "summaryYears",
  "favoriteFilms",
  "favoriteDecade",
];

function slimStats(stats: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of STAT_FIELDS) {
    if (stats[key] !== undefined) out[key] = stats[key];
  }
  if (out.counts === undefined) out.counts = pickCounts(stats);
  return out;
}

function reviewTextOf(entry: Record<string, unknown>): string | null {
  if (typeof entry.review === "string") return entry.review;
  if (isRecord(entry.review) && typeof entry.review.text === "string") return entry.review.text;
  return null;
}

function diaryMatches(
  entry: Record<string, unknown>,
  filters: { minRating?: number; maxRating?: number; rewatchesOnly?: boolean },
): boolean {
  const value = entry.rating;
  if (filters.minRating !== undefined && (typeof value !== "number" || value < filters.minRating)) {
    return false;
  }
  if (filters.maxRating !== undefined && (typeof value !== "number" || value > filters.maxRating)) {
    return false;
  }
  if (filters.rewatchesOnly) {
    const details = entry.diaryDetails;
    if (!isRecord(details) || details.rewatch !== true) return false;
  }
  return true;
}

function genreSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

async function fetchWatchlist(env: Env, path: string, query: Query, cursor?: string) {
  return briefPage(await requestPage(env, path, query, { auth: "member" }, cursor));
}

export function registerHistoryTools(server: McpServer, deps: ToolDeps): void {
  const { env } = deps;
  const guard = makeGuard(env);

  server.registerTool(
    "whoami",
    {
      description:
        "Report the linked Letterboxd account (linked, broken, username, memberId) and headline statistics counts.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      guard(async () => {
        const status = await tokenStore(env).status();
        const result: Record<string, unknown> = {
          linked: status.linked,
          broken: status.broken,
          username: status.username ?? null,
          memberId: status.memberId ?? null,
        };
        if (status.linked && !status.broken && status.memberId) {
          try {
            const stats = await lbRequest<Record<string, unknown>>(
              env,
              "GET",
              `/member/${encodeURIComponent(status.memberId)}/statistics`,
              { auth: "member" },
            );
            result.counts = pickCounts(stats);
          } catch (error) {
            // Identity is still useful when statistics are unavailable.
            if (!(error instanceof LetterboxdApiError)) throw error;
          }
        }
        return result;
      }),
  );

  server.registerTool(
    "get_diary",
    {
      description:
        "List diary entries for the linked member (or another member), newest first by default.",
      inputSchema: {
        member: MEMBER,
        year: z.number().int().min(1874).max(2200).optional().describe("Diary year to filter by"),
        month: z.number().int().min(1).max(12).optional().describe("Month (1-12) within year"),
        film: z.string().optional().describe("Film id, slug, or Letterboxd URL to filter by"),
        minRating: ratingSchema.optional().describe("Minimum rating (0.5-5)"),
        maxRating: ratingSchema.optional().describe("Maximum rating (0.5-5)"),
        reviewsOnly: z.boolean().optional().describe("Only entries that have a review"),
        rewatchesOnly: z.boolean().optional().describe("Only rewatch entries"),
        sort: z
          .enum(["newest", "oldest", "highestRated", "lowestRated", "recentlyAdded"])
          .default("newest")
          .describe("Sort order (default newest)"),
        perPage: PER_PAGE_20,
        cursor: CURSOR,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const memberId = await resolveMemberId(env, input.member);
        const filmId = input.film ? await resolveFilmId(env, input.film) : undefined;
        const query: Query = {
          member: memberId,
          where: input.reviewsOnly ? ["HasDiaryDate", "HasReview"] : ["HasDiaryDate"],
          year: input.year,
          month: input.month,
          filmId,
          sort: DIARY_SORTS[input.sort] ?? "Date",
          perPage: input.perPage,
        };
        const page = await requestPage(env, "/log-entries", query, { auth: "member" }, input.cursor);
        // min/maxRating and rewatches are client-side: the API may not filter on them.
        const items = page.items.filter((entry) => diaryMatches(entry, input));
        return {
          items: items.map(toEntry),
          nextCursor: page.nextCursor,
          count: items.length,
          truncated: page.truncated,
        };
      }),
  );

  server.registerTool(
    "get_log_entry",
    {
      description: "Fetch a single diary log entry by id, including the full review text.",
      inputSchema: { id: z.string().describe("Log entry id (from get_diary)") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const entry = await lbRequest<Record<string, unknown>>(
          env,
          "GET",
          `/log-entry/${encodeURIComponent(input.id)}`,
          { auth: "member" },
        );
        return { ...toEntry(entry), reviewText: reviewTextOf(entry) };
      }),
  );

  server.registerTool(
    "find_films",
    {
      description:
        "Find films in the linked member's watched/liked/rated/watchlist collection with catalog filters.",
      inputSchema: {
        member: MEMBER,
        relationship: z
          .enum(["watched", "liked", "rated", "watchlist"])
          .default("watched")
          .describe("Which member relationship to list (default watched)"),
        genre: z.string().optional().describe("Genre name or slug to include, e.g. 'Science Fiction'"),
        excludeGenre: z.string().optional().describe("Genre name or slug to exclude"),
        decade: z.number().int().min(1870).max(2200).optional().describe("Decade start year, e.g. 1990"),
        year: z.number().int().min(1874).max(2200).optional().describe("Release year"),
        country: z.string().optional().describe("Country slug"),
        language: z.string().optional().describe("Language slug"),
        minRating: ratingSchema.optional().describe("Minimum member rating (0.5-5)"),
        maxRating: ratingSchema.optional().describe("Maximum member rating (0.5-5)"),
        sort: z
          .enum([
            "myRatingHigh",
            "myRatingLow",
            "dateLatest",
            "dateEarliest",
            "releaseNewest",
            "releaseOldest",
            "popular",
            "averageRatingHigh",
            "shortest",
            "longest",
          ])
          .default("dateLatest")
          .describe("Sort order (default dateLatest)"),
        perPage: PER_PAGE_20,
        cursor: CURSOR,
        countOnly: z.boolean().optional().describe("Return only the total count, no items"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const memberId = await resolveMemberId(env, input.member);
        const filters: Query = {
          member: memberId,
          memberRelationship: FILM_RELATIONSHIPS[input.relationship] ?? "Watched",
          genre: input.genre ? genreSlug(input.genre) : undefined,
          excludeGenre: input.excludeGenre ? genreSlug(input.excludeGenre) : undefined,
          decade: input.decade,
          year: input.year,
          country: input.country,
          language: input.language,
          memberMinRating: input.minRating,
          memberMaxRating: input.maxRating,
        };
        if (input.countOnly) {
          const page = await lbRequest<{ count?: unknown; items?: unknown }>(env, "GET", "/films", {
            query: { ...filters, countItems: true, perPage: 1 },
            auth: "member",
          });
          return {
            count: typeof page.count === "number" ? page.count : asRecords(page.items).length,
          };
        }
        const query: Query = {
          ...filters,
          sort: FILM_SORTS[input.sort] ?? "DateLatestFirst",
          perPage: input.perPage,
        };
        return briefPage(await requestPage(env, "/films", query, { auth: "member" }, input.cursor));
      }),
  );

  server.registerTool(
    "get_watchlist",
    {
      description: "List the linked member's watchlist, newest additions first by default.",
      inputSchema: {
        member: MEMBER,
        genre: z.string().optional().describe("Genre name or slug to filter by"),
        decade: z.number().int().min(1870).max(2200).optional().describe("Decade start year, e.g. 1990"),
        sort: z
          .enum([
            "myRatingHigh",
            "myRatingLow",
            "dateLatest",
            "dateEarliest",
            "releaseNewest",
            "releaseOldest",
            "popular",
            "averageRatingHigh",
            "shortest",
            "longest",
          ])
          .default("dateLatest")
          .describe("Sort order (default dateLatest)"),
        perPage: PER_PAGE_20,
        cursor: CURSOR,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const memberId = await resolveMemberId(env, input.member);
        const query: Query = {
          genre: input.genre ? genreSlug(input.genre) : undefined,
          decade: input.decade,
          sort: FILM_SORTS[input.sort] ?? "DateLatestFirst",
          perPage: input.perPage,
        };
        try {
          return await fetchWatchlist(
            env,
            `/member/${encodeURIComponent(memberId)}/watchlist`,
            query,
            input.cursor,
          );
        } catch (error) {
          if (
            !(error instanceof LetterboxdApiError) ||
            (error.status !== 400 && error.status !== 404)
          ) {
            throw error;
          }
          // Older API surface: watchlist as a member relationship on /films.
          return await fetchWatchlist(
            env,
            "/films",
            { ...query, member: memberId, memberRelationship: "InWatchlist" },
            input.cursor,
          );
        }
      }),
  );

  server.registerTool(
    "get_member_stats",
    {
      description: "Get member statistics: counts, rating histogram, and years in review when present.",
      inputSchema: { member: MEMBER },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const memberId = await resolveMemberId(env, input.member);
        const stats = await lbRequest<Record<string, unknown>>(
          env,
          "GET",
          `/member/${encodeURIComponent(memberId)}/statistics`,
          { auth: "any" },
        );
        return slimStats(stats);
      }),
  );
}
