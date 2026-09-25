import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  LetterboxdApiError,
  LetterboxdNotLinkedError,
  lbRequest,
} from "../../upstream/client";
import { toFilmBrief, toFilmDetail, toMyFilmStatus } from "../../upstream/format";
import { resolveFilmId } from "../../upstream/resolve";
import { asParam, asRecords, isRecord, makeGuard, type ToolDeps } from "../handler";

type FilmBriefArg = Parameters<typeof toFilmBrief>[0];
type FilmDetailArgs = Parameters<typeof toFilmDetail>;
type MyStatusArgs = Parameters<typeof toMyFilmStatus>;

const toBrief = (raw: Record<string, unknown>) =>
  toFilmBrief(asParam<FilmBriefArg>(raw));

export function registerFilmTools(server: McpServer, deps: ToolDeps): void {
  const { env } = deps;
  const guard = makeGuard(env);

  server.registerTool(
    "search_films",
    {
      description: "Search the Letterboxd film catalog by title, director, or cast.",
      inputSchema: {
        query: z.string().min(1).describe("Search text, e.g. a film title"),
        year: z
          .number()
          .int()
          .min(1874)
          .max(2200)
          .optional()
          .describe("Only films released this year (filtered client-side)"),
        perPage: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("Results per page (1-100, default 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const page = await lbRequest<{ items?: unknown }>(env, "GET", "/search", {
          query: {
            input: input.query,
            include: "FilmSearchItem",
            searchMethod: "FullText",
            perPage: input.perPage,
          },
          auth: "app",
          cacheTtl: 3600,
        });
        const items: unknown[] = [];
        const otherMatches: unknown[] = [];
        for (const item of asRecords(page.items)) {
          const film = isRecord(item.film) ? item.film : undefined;
          if (!film) {
            otherMatches.push(item);
            continue;
          }
          if (input.year === undefined || Number(film.releaseYear ?? film.year) === input.year) {
            items.push(toBrief(film));
          }
        }
        return { items, count: items.length, otherMatches };
      }),
  );

  server.registerTool(
    "get_film",
    {
      description:
        "Get film details and statistics, plus the linked member's rating/watch/like status when available.",
      inputSchema: {
        film: z.string().describe("Film id, slug, or Letterboxd URL, e.g. '2CZEm' or a letterboxd.com link"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guard(async () => {
        const filmId = await resolveFilmId(env, input.film);
        // Resolved ids are validated (LID, tmdb:..., imdb lookup or HEAD result);
        // percent-encoding would corrupt `tmdb:<id>`.
        const path = `/film/${filmId}`;
        const [film, stats, myStatus] = await Promise.all([
          lbRequest<Record<string, unknown>>(env, "GET", path, { auth: "app", cacheTtl: 43200 }),
          lbRequest<Record<string, unknown>>(env, "GET", `${path}/statistics`, {
            auth: "app",
            cacheTtl: 3600,
          }),
          // Member status needs a healthy link; 403/404 or no link simply omits it.
          lbRequest<Record<string, unknown>>(env, "GET", `${path}/me`, { auth: "member" }).catch(
            (error: unknown) => {
              if (error instanceof LetterboxdNotLinkedError) return null;
              if (
                error instanceof LetterboxdApiError &&
                (error.status === 403 || error.status === 404)
              ) {
                return null;
              }
              throw error;
            },
          ),
        ]);
        return toFilmDetail(
          asParam<FilmDetailArgs[0]>(film),
          asParam<FilmDetailArgs[1]>(stats),
          asParam<FilmDetailArgs[2]>(myStatus ?? undefined),
        );
      }),
  );

  server.registerTool(
    "get_my_film_status",
    {
      description: "Get the linked member's own status for a film: watched, liked, rating, watchlist.",
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
          `/film/${filmId}/me`,
          { auth: "member" },
        );
        const data = isRecord(response.data) ? response.data : response;
        const film = isRecord(data.film) ? data.film : { id: filmId };
        return toMyFilmStatus(
          asParam<MyStatusArgs[0]>(film),
          asParam<MyStatusArgs[1]>(data),
        );
      }),
  );
}
