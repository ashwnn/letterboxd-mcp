import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LetterboxdApiError, lbRequest } from "../../upstream/client";
import { toActivityItem, toFilmBrief, trimReview } from "../../upstream/format";
import { resolveFilmId, resolveMemberId } from "../../upstream/resolve";
import {
  asParam,
  asRecords,
  isRecord,
  makeGuard,
  requestPage,
  type Query,
  type ToolDeps,
} from "../handler";

type ActivityItemArg = Parameters<typeof toActivityItem>[0];
type FilmBriefArg = Parameters<typeof toFilmBrief>[0];

const toActivity = (raw: Record<string, unknown>) =>
  toActivityItem(asParam<ActivityItemArg>(raw));
const toBrief = (raw: Record<string, unknown>) => toFilmBrief(asParam<FilmBriefArg>(raw));

const PER_PAGE_30 = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(30)
  .describe("Items per page (1-100, default 30)");
const PER_PAGE_20 = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20)
  .describe("Items per page (1-100, default 20)");
const CURSOR = z.string().optional().describe("Pagination cursor from a previous response");

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function hasReview(item: Record<string, unknown>): boolean {
  const review = item.review;
  if (typeof review === "string") return review.length > 0;
  if (isRecord(review)) return typeof review.text === "string" && review.text.length > 0;
  return false;
}

function isDiaryReviewRating(item: Record<string, unknown>): boolean {
  const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
  if (type) return type.includes("diary") || type.includes("review") || type.includes("rating");
  return item.diaryDetails !== undefined || item.rating !== undefined || item.review !== undefined;
}

interface FriendOnFilm {
  member: unknown;
  rating: number | null;
  liked: boolean | null;
  watched: boolean | null;
  reviewSnippet: string | null;
}

function reviewTextOf(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (isRecord(value) && typeof value.text === "string") return value.text;
  return null;
}

function friendItem(raw: Record<string, unknown>): FriendOnFilm {
  const relationship = isRecord(raw.relationship) ? raw.relationship : raw;
  const logEntry = isRecord(raw.logEntry) ? raw.logEntry : null;
  const reviewText =
    reviewTextOf(raw.review) ??
    reviewTextOf(relationship.review) ??
    (logEntry ? reviewTextOf(logEntry.review) : null);
  const snippet = reviewText === null ? null : trimReview(reviewText, 280);
  return {
    member: raw.member ?? raw.user ?? null,
    rating: typeof relationship.rating === "number" ? relationship.rating : null,
    liked: boolOrNull(relationship.liked ?? relationship.like),
    watched: boolOrNull(relationship.watched),
    reviewSnippet: snippet === null ? null : snippet.text,
  };
}

interface MemberBrief {
  id: unknown;
  username: unknown;
  displayName: unknown;
  url: string | null;
}

function memberBrief(raw: Record<string, unknown>): MemberBrief {
  const links = Array.isArray(raw.links) ? raw.links.filter(isRecord) : [];
  const letterboxd = links.find((link) => link.type === "letterboxd");
  const username = typeof raw.username === "string" ? raw.username : null;
  const url =
    letterboxd && typeof letterboxd.url === "string"
      ? letterboxd.url
      : typeof raw.url === "string"
        ? raw.url
        : username
          ? `https://letterboxd.com/${username}/`
          : null;
  return {
    id: raw.id ?? null,
    username: raw.username ?? null,
    displayName: raw.displayName ?? raw.name ?? null,
    url,
  };
}

export function registerSocialTools(server: McpServer, deps: ToolDeps): void {
  const { env } = deps;
  const guard = makeGuard(env);

  server.registerTool(
    "get_friends_activity",
    {
      description:
        "List recent activity from the linked member's friends: diary entries, reviews, and ratings.",
      inputSchema: {
        perPage: PER_PAGE_30,
        cursor: CURSOR,
        reviewsOnly: z.boolean().optional().describe("Only activity that includes a review"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const memberId = await resolveMemberId(env);
        const query: Query = {
          member: memberId,
          includeFriends: "Only",
          sort: "WhenAdded",
          perPage: input.perPage,
        };
        try {
          const page = await requestPage(env, "/log-entries", query, { auth: "member" }, input.cursor);
          const items = page.items.filter((item) => !input.reviewsOnly || hasReview(item));
          return {
            items: items.map(toActivity),
            nextCursor: page.nextCursor,
            count: items.length,
            truncated: page.truncated,
          };
        } catch (error) {
          if (!(error instanceof LetterboxdApiError)) throw error;
          // Older API surface: the member activity feed.
          const page = await requestPage(
            env,
            `/member/${encodeURIComponent(memberId)}/activity`,
            { perPage: input.perPage },
            { auth: "member" },
            input.cursor,
          );
          const items = page.items.filter(
            (item) => isDiaryReviewRating(item) && (!input.reviewsOnly || hasReview(item)),
          );
          return {
            items: items.map(toActivity),
            nextCursor: page.nextCursor,
            count: items.length,
            truncated: page.truncated,
          };
        }
      }),
  );

  server.registerTool(
    "get_friends_on_film",
    {
      description: "List friends who have seen a film, with their rating, like, and review snippet.",
      inputSchema: {
        film: z.string().describe("Film id, slug, or Letterboxd URL, e.g. '2CZEm' or a letterboxd.com link"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const filmId = await resolveFilmId(env, input.film);
        const response = await lbRequest<Record<string, unknown>>(
          env,
          "GET",
          `/film/${filmId}/friends`,
          { auth: "member" },
        );
        const items = asRecords(response.items ?? response.friends).map(friendItem);
        const ratings = items
          .map((item) => item.rating)
          .filter((rating): rating is number => typeof rating === "number");
        const averageRating =
          typeof response.averageRating === "number"
            ? response.averageRating
            : ratings.length > 0
              ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 100) /
                100
              : null;
        return {
          film: isRecord(response.film) ? toBrief(response.film) : { id: filmId },
          items,
          count:
            typeof response.itemCount === "number"
              ? response.itemCount
              : typeof response.count === "number"
                ? response.count
                : items.length,
          averageRating,
        };
      }),
  );

  server.registerTool(
    "get_following",
    {
      description: "List the accounts the linked member (or another member) follows.",
      inputSchema: {
        member: z
          .string()
          .optional()
          .describe("Letterboxd username or member id; defaults to the linked account"),
        perPage: PER_PAGE_20,
        cursor: CURSOR,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const memberId = await resolveMemberId(env, input.member);
        const page = await requestPage(
          env,
          "/members",
          { member: memberId, memberRelationship: "IsFollowing", perPage: input.perPage },
          { auth: "any" },
          input.cursor,
        );
        return {
          items: page.items.map(memberBrief),
          nextCursor: page.nextCursor,
          count: page.items.length,
          truncated: page.truncated,
        };
      }),
  );
}
