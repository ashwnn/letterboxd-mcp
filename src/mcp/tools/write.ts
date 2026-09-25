import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../../env";
import { lbRequest } from "../../upstream/client";
import { toDiaryEntry, toFilmBrief, toMyFilmStatus } from "../../upstream/format";
import { resolveFilmId, resolveMemberId } from "../../upstream/resolve";
import {
  asParam,
  asRecords,
  isRecord,
  makeGuard,
  toolError,
  type ToolDeps,
} from "../handler";

type DiaryEntryArg = Parameters<typeof toDiaryEntry>[0];
type FilmBriefArg = Parameters<typeof toFilmBrief>[0];
type MyStatusArgs = Parameters<typeof toMyFilmStatus>;

const toEntry = (raw: Record<string, unknown>) => toDiaryEntry(asParam<DiaryEntryArg>(raw));
const toBrief = (raw: Record<string, unknown>) => toFilmBrief(asParam<FilmBriefArg>(raw));

const WRITE_DISABLED = "Write access is not granted for this connection.";

const ratingSchema = z.number().min(0.5).max(5).multipleOf(0.5);
const nullableRatingSchema = ratingSchema.nullable();
const FILM_INPUT = z
  .string()
  .describe("Film id, slug, or Letterboxd URL, e.g. '2CZEm' or a letterboxd.com link (not free-text)");
const WATCHED_ON = z
  .string()
  .nullable()
  .optional()
  .describe(
    "YYYY-MM-DD, 'today', 'yesterday', or null for no diary date (defaults to today in the server timezone)",
  );
const TAGS = z
  .array(z.string())
  .optional()
  .describe("Tags (trimmed, lowercased, deduped; max 50 tags of max 100 characters each)");
const REVIEW_TEXT = z.string().max(10000).describe("Review text (max 10,000 characters)");

function todayInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

function shiftDate(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Resolves today/yesterday/YYYY-MM-DD in the configured timezone; null means "no diary date". */
function normalizeDate(value: string | null | undefined, timeZone: string): string | null {
  if (value === null) return null;
  const today = todayInTimeZone(timeZone);
  const raw = (value ?? "today").trim();
  const resolved = raw === "today" ? today : raw === "yesterday" ? shiftDate(today, -1) : raw;
  if (!isValidCalendarDate(resolved)) {
    throw new Error(`Invalid date "${raw}": expected YYYY-MM-DD, "today", or "yesterday".`);
  }
  if (resolved > today) throw new Error(`Date cannot be in the future: ${resolved}.`);
  return resolved;
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    if (tag.length > 100) throw new Error("Each tag must be 100 characters or fewer.");
    seen.add(tag);
    out.push(tag);
  }
  if (out.length > 50) throw new Error("At most 50 tags are allowed per entry.");
  return out;
}

function diaryDateOf(entry: Record<string, unknown>): string | null {
  const details = entry.diaryDetails;
  if (isRecord(details) && typeof details.diaryDate === "string") return details.diaryDate;
  return null;
}

function messagesOf(response: Record<string, unknown>): unknown[] {
  return Array.isArray(response.messages) ? response.messages : [];
}

async function findDuplicate(
  env: Env,
  filmId: string,
  diaryDate: string,
): Promise<string | null> {
  const memberId = await resolveMemberId(env);
  const page = await lbRequest<{ items?: unknown }>(env, "GET", "/log-entries", {
    // GET /log-entries filters by `film`; `filmId` is the POST /log-entries field.
    query: { film: filmId, member: memberId, where: "HasDiaryDate", perPage: 100 },
    auth: "member",
  });
  for (const entry of asRecords(page.items)) {
    if (diaryDateOf(entry) !== diaryDate) continue;
    return typeof entry.id === "string" ? entry.id : null;
  }
  return null;
}

async function fetchOwnedEntry(env: Env, id: string): Promise<Record<string, unknown>> {
  const entry = await lbRequest<Record<string, unknown>>(
    env,
    "GET",
    `/log-entry/${encodeURIComponent(id)}`,
    { auth: "member" },
  );
  const memberId = await resolveMemberId(env);
  const owner = isRecord(entry.owner) ? entry.owner : undefined;
  if (!owner || owner.id !== memberId) {
    throw new Error(`Log entry ${id} belongs to a different Letterboxd account.`);
  }
  return entry;
}

export function registerWriteTools(server: McpServer, deps: ToolDeps): void {
  const { env } = deps;
  const guard = makeGuard(env);

  server.registerTool(
    "log_film",
    {
      description:
        "Log a film to the linked Letterboxd account with an optional diary date, rating, like, review, and tags. Only call after the user has clearly asked to change their Letterboxd account.",
      inputSchema: {
        film: FILM_INPUT,
        watchedOn: WATCHED_ON,
        rating: ratingSchema.optional().describe("Rating from 0.5 to 5 in half-star steps"),
        liked: z.boolean().optional().describe("Mark the film as liked"),
        rewatch: z.boolean().optional().describe("Mark the viewing as a rewatch (used with a diary date)"),
        review: REVIEW_TEXT.optional(),
        containsSpoilers: z.boolean().optional().describe("Mark the review as containing spoilers"),
        tags: TAGS,
        allowDuplicate: z
          .boolean()
          .optional()
          .describe("Allow a second diary entry for the same film and date"),
      },
      annotations: { readOnlyHint: false },
    },
    (input) => {
      if (!deps.canWrite) return toolError(WRITE_DISABLED);
      return guard(async () => {
        const filmId = await resolveFilmId(env, input.film);
        const diaryDate = normalizeDate(input.watchedOn, env.TIMEZONE);
        const tags = input.tags ? normalizeTags(input.tags) : undefined;
        if (diaryDate !== null && !input.allowDuplicate) {
          const duplicateId = await findDuplicate(env, filmId, diaryDate);
          if (duplicateId) return { duplicate: true, existingEntryId: duplicateId };
        }
        const body: Record<string, unknown> = { filmId };
        if (diaryDate !== null) {
          body.diaryDetails = { diaryDate, rewatch: input.rewatch === true };
        }
        if (input.review !== undefined) {
          body.review = { text: input.review, containsSpoilers: input.containsSpoilers === true };
        }
        if (tags !== undefined) body.tags = tags;
        if (input.rating !== undefined) body.rating = input.rating;
        if (input.liked !== undefined) body.like = input.liked;
        const response = await lbRequest<Record<string, unknown>>(env, "POST", "/log-entries", {
          body,
          auth: "member",
        });
        const entry = isRecord(response.data) ? response.data : response;
        return { ...toEntry(entry), messages: messagesOf(response) };
      });
    },
  );

  server.registerTool(
    "set_film_status",
    {
      description:
        "Set a film's watched, liked, watchlist, or rating status for the linked Letterboxd account. Only call after the user has clearly asked to change their Letterboxd account.",
      inputSchema: {
        film: FILM_INPUT,
        rating: nullableRatingSchema.optional().describe("New rating 0.5-5 in half-star steps, or null to clear"),
        watched: z.boolean().optional().describe("Mark as watched or unwatched"),
        liked: z.boolean().optional().describe("Mark as liked or unliked"),
        inWatchlist: z.boolean().optional().describe("Add to or remove from the watchlist"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    (input) => {
      if (!deps.canWrite) return toolError(WRITE_DISABLED);
      if (
        input.rating === undefined &&
        input.watched === undefined &&
        input.liked === undefined &&
        input.inWatchlist === undefined
      ) {
        return toolError("Provide at least one of rating, watched, liked, or inWatchlist.");
      }
      return guard(async () => {
        const filmId = await resolveFilmId(env, input.film);
        const body: Record<string, unknown> = {};
        if (input.rating !== undefined) body.rating = input.rating;
        if (input.watched !== undefined) body.watched = input.watched;
        if (input.liked !== undefined) body.liked = input.liked;
        if (input.inWatchlist !== undefined) body.inWatchlist = input.inWatchlist;
        const response = await lbRequest<Record<string, unknown>>(
          env,
          "PATCH",
          `/film/${filmId}/me`,
          { body, auth: "member" },
        );
        const data = isRecord(response.data) ? response.data : response;
        const film = isRecord(data.film)
          ? data.film
          : isRecord(response.film)
            ? response.film
            : { id: filmId };
        return {
          ...toMyFilmStatus(asParam<MyStatusArgs[0]>(film), asParam<MyStatusArgs[1]>(data)),
          messages: messagesOf(response),
        };
      });
    },
  );

  server.registerTool(
    "update_log_entry",
    {
      description:
        "Update an existing diary log entry (date, rating, like, rewatch, review, tags). Only call after the user has clearly asked to change their Letterboxd account.",
      inputSchema: {
        id: z.string().describe("Log entry id (from get_diary)"),
        watchedOn: WATCHED_ON,
        rating: nullableRatingSchema.optional().describe("New rating 0.5-5, or null to clear"),
        liked: z.boolean().optional().describe("Mark the entry as liked or unliked"),
        rewatch: z.boolean().optional().describe("Mark the entry as a rewatch or not"),
        review: z
          .string()
          .max(10000)
          .nullable()
          .optional()
          .describe("New review text (max 10,000 characters), or null to remove the review"),
        containsSpoilers: z.boolean().optional().describe("Mark the review as containing spoilers"),
        tags: TAGS,
      },
      annotations: { readOnlyHint: false },
    },
    (input) => {
      if (!deps.canWrite) return toolError(WRITE_DISABLED);
      return guard(async () => {
        const existing = await fetchOwnedEntry(env, input.id);
        const existingDiary = isRecord(existing.diaryDetails) ? existing.diaryDetails : {};
        const existingReview = isRecord(existing.review) ? existing.review : undefined;
        const body: Record<string, unknown> = {};
        let diaryTouched = false;
        const diary: Record<string, unknown> = { ...existingDiary };
        if (input.watchedOn !== undefined) {
          diary.diaryDate = normalizeDate(input.watchedOn, env.TIMEZONE);
          diaryTouched = true;
        }
        if (input.rewatch !== undefined) {
          diary.rewatch = input.rewatch;
          diaryTouched = true;
        }
        if (diaryTouched) body.diaryDetails = diary;
        if (input.review !== undefined) {
          if (input.review === null) {
            body.review = null;
          } else {
            const existingSpoilers =
              existingReview && typeof existingReview.containsSpoilers === "boolean"
                ? existingReview.containsSpoilers
                : false;
            body.review = {
              text: input.review,
              containsSpoilers: input.containsSpoilers ?? existingSpoilers,
            };
          }
        } else if (
          input.containsSpoilers !== undefined &&
          existingReview &&
          typeof existingReview.text === "string"
        ) {
          body.review = { text: existingReview.text, containsSpoilers: input.containsSpoilers };
        }
        if (input.rating !== undefined) body.rating = input.rating;
        if (input.liked !== undefined) body.like = input.liked;
        if (input.tags !== undefined) body.tags = normalizeTags(input.tags);
        if (Object.keys(body).length === 0) throw new Error("No changes were provided.");
        const response = await lbRequest<Record<string, unknown>>(
          env,
          "PATCH",
          `/log-entry/${encodeURIComponent(input.id)}`,
          { body, auth: "member" },
        );
        const entry = isRecord(response.data) ? response.data : response;
        return { ...toEntry(entry), messages: messagesOf(response) };
      });
    },
  );

  server.registerTool(
    "delete_log_entry",
    {
      description:
        "Delete a diary log entry from the linked Letterboxd account. Only call after the user has clearly asked to change their Letterboxd account.",
      inputSchema: {
        id: z.string().describe("Log entry id (from get_diary)"),
        confirm: z.literal(true).describe("Must be true; confirms the user asked to delete this entry"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    (input) => {
      if (!deps.canWrite) return toolError(WRITE_DISABLED);
      return guard(async () => {
        const existing = await fetchOwnedEntry(env, input.id);
        await lbRequest<unknown>(env, "DELETE", `/log-entry/${encodeURIComponent(input.id)}`, {
          auth: "member",
        });
        const film = existing.film ?? existing.production ?? null;
        return {
          deleted: true,
          id: input.id,
          film: isRecord(film) ? toBrief(film) : (film ?? null),
        };
      });
    },
  );
}
