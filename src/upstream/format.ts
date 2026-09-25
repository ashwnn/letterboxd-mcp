/**
 * Compact output shapes for the MCP tools. Formatters are defensive: Letterboxd
 * responses vary between endpoints (bare entities vs `{ data: ... }` envelopes,
 * `name` vs `title`, `tags2` vs `tags`), so every field is read through guards.
 */

type AnyRecord = Record<string, unknown>;

function rec(value: unknown): AnyRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function records(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.map(rec).filter((item): item is AnyRecord => item !== null) : [];
}

function names(value: unknown): string[] {
  return records(value)
    .map((item) => str(item.name))
    .filter((name): name is string => name !== null);
}

function unwrap(value: unknown): AnyRecord {
  const record = rec(value);
  if (!record) return {};
  const data = rec(record.data);
  return data ?? record;
}

export interface FilmBrief {
  id: string;
  title: string;
  year: number | null;
  directors: string[];
  url: string;
}

export interface FilmDetail extends FilmBrief {
  runtimeMinutes: number | null;
  tagline: string | null;
  synopsis: string | null;
  genres: string[];
  countries: string[];
  languages: string[];
  cast: { name: string; character: string | null }[];
  crew: { role: string; names: string[] }[];
  tmdbId: string | null;
  imdbId: string | null;
  averageRating: number | null;
  counts: {
    watches: number | null;
    likes: number | null;
    ratings: number | null;
    reviews: number | null;
    lists: number | null;
    fans: number | null;
  };
  myStatus?: MyFilmStatus;
}

export interface MyFilmStatus {
  film: FilmBrief;
  watched: boolean;
  liked: boolean;
  inWatchlist: boolean;
  favorited: boolean;
  rating: number | null;
  diaryEntryIds: string[];
  reviewIds: string[];
}

export interface DiaryEntry {
  id: string;
  film: FilmBrief;
  watchedOn: string | null;
  rewatch: boolean;
  rating: number | null;
  liked: boolean;
  review: string | null;
  reviewTruncated: boolean;
  containsSpoilers: boolean;
  tags: string[];
  createdAt: string | null;
  url: string;
}

export interface ActivityItem {
  member: { id: string; username: string; displayName: string | null };
  type: string;
  film: FilmBrief;
  rating: number | null;
  liked: boolean;
  rewatch: boolean;
  watchedOn: string | null;
  reviewSnippet: string | null;
  when: string | null;
}

function filmUrl(film: AnyRecord, id: string): string {
  const letterboxd = records(film.links).find((link) => link.type === "letterboxd");
  const fromLinks = letterboxd ? str(letterboxd.url) : null;
  if (fromLinks) return fromLinks;
  const link = str(film.link);
  if (link) return link;
  return id ? `https://boxd.it/${id}` : "";
}

/**
 * `Film` carries `contributions` (deprecated but still populated), where each
 * entry is `{ type, contributors: [{ name, characterName }] }`. Older responses
 * (and some endpoints) use a single `contributor` plus `job`, so both are read.
 */
interface ContributionEntry {
  type: string;
  people: { name: string; character: string | null }[];
}

function contributionsOf(film: AnyRecord): ContributionEntry[] {
  const entries: ContributionEntry[] = [];
  for (const item of records(film.contributions)) {
    const type = String(item.type ?? "");
    const list = records(item.contributors);
    if (list.length > 0) {
      entries.push({
        type,
        people: list.map((person) => ({
          name: str(person.name) ?? "",
          character: str(person.characterName),
        })),
      });
      continue;
    }
    const single = rec(item.contributor);
    if (single) {
      entries.push({
        type,
        people: [{ name: str(single.name) ?? "", character: str(item.job) }],
      });
    }
  }
  return entries;
}

function directorsOf(film: AnyRecord): string[] {
  const direct = names(film.directors);
  if (direct.length > 0) return direct;
  return contributionsOf(film)
    .filter((entry) => /^co?-?director$/i.test(entry.type))
    .flatMap((entry) => entry.people.map((person) => person.name))
    .filter((name) => name.length > 0);
}

export function toFilmBrief(film: unknown): FilmBrief {
  const f = unwrap(film);
  const id = str(f.id) ?? "";
  return {
    id,
    title: str(f.name) ?? str(f.title) ?? "Unknown film",
    year: num(f.releaseYear) ?? num(f.year),
    directors: directorsOf(f),
    url: filmUrl(f, id),
  };
}

const CREW_ROLES = ["Director", "Writer", "Cinematography", "Composer", "Editor"];

function castOf(film: AnyRecord): { name: string; character: string | null }[] {
  return contributionsOf(film)
    .filter((entry) => entry.type.toLowerCase() === "actor")
    .flatMap((entry) => entry.people)
    .filter((person) => person.name.length > 0)
    .slice(0, 10);
}

function crewOf(film: AnyRecord): { role: string; names: string[] }[] {
  const contributions = contributionsOf(film);
  const crew: { role: string; names: string[] }[] = [];
  for (const role of CREW_ROLES) {
    const roleNames = contributions
      .filter((entry) => entry.type.toLowerCase() === role.toLowerCase())
      .flatMap((entry) => entry.people.map((person) => person.name))
      .filter((name) => name.length > 0);
    if (roleNames.length > 0) crew.push({ role, names: roleNames });
  }
  return crew;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : str(rec(item)?.name)))
    .filter((item): item is string => item !== null);
}

function externalId(film: AnyRecord, kind: "tmdb" | "imdb"): string | null {
  const link = records(film.links).find((item) => item.type === kind);
  const url = link ? str(link.url) : null;
  if (!url) return null;
  if (kind === "tmdb") return /\/movie\/(\d+)/.exec(url)?.[1] ?? null;
  return /title\/(tt\d+)/.exec(url)?.[1] ?? null;
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : str(rec(item)?.id)))
    .filter((id): id is string => id !== null);
}

export function toMyFilmStatus(film: unknown, relationship: unknown): MyFilmStatus {
  const f = unwrap(film);
  const r = unwrap(relationship);
  // ProductionRelationship has no film object, only `productionId`.
  const filmValue =
    rec(r.film) ??
    rec(r.production) ??
    (str(r.productionId) ? { id: r.productionId } : f);
  return {
    film: toFilmBrief(filmValue),
    watched: r.watched === true,
    liked: r.liked === true || r.like === true,
    inWatchlist: r.inWatchlist === true,
    favorited: r.favorited === true || r.favourite === true,
    rating: num(r.rating),
    diaryEntryIds: idsOf(r.diaryEntries ?? r.diaryEntryIds),
    reviewIds: idsOf(r.reviews ?? r.reviewIds),
  };
}

export function toFilmDetail(
  film: unknown,
  stats: unknown,
  myStatus?: unknown,
): FilmDetail {
  const f = unwrap(film);
  const s = unwrap(stats);
  const counts = rec(s.counts) ?? {};
  const detail: FilmDetail = {
    ...toFilmBrief(f),
    runtimeMinutes: num(f.runTime) ?? num(f.runtime),
    tagline: str(f.tagline),
    synopsis: str(f.synopsis) ?? str(f.description),
    genres: stringList(f.genres),
    countries: stringList(f.countries),
    languages: stringList(f.languages),
    cast: castOf(f),
    crew: crewOf(f),
    tmdbId: externalId(f, "tmdb"),
    imdbId: externalId(f, "imdb"),
    averageRating: num(s.rating) ?? num(f.rating),
    counts: {
      watches: num(counts.watches),
      likes: num(counts.likes),
      ratings: num(counts.ratings),
      reviews: num(counts.reviews),
      lists: num(counts.lists),
      fans: num(counts.fans),
    },
  };
  if (myStatus !== undefined && myStatus !== null) {
    detail.myStatus = toMyFilmStatus(f, myStatus);
  }
  return detail;
}

export function trimReview(
  text: string | null | undefined,
  max = 600,
): { text: string | null; truncated: boolean } {
  if (text === null || text === undefined) return { text: null, truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function reviewText(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  const review = rec(value);
  return review ? str(review.text) : null;
}

function tagsOf(entry: AnyRecord): string[] {
  const raw = entry.tags2 ?? entry.tags;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) =>
      typeof item === "string"
        ? item
        : str(rec(item)?.displayTag) ?? str(rec(item)?.code) ?? str(rec(item)?.tag),
    )
    .filter((tag): tag is string => tag !== null);
}

function entryUrl(entry: AnyRecord, fallbackId: string): string {
  const letterboxd = records(entry.links).find((link) => link.type === "letterboxd");
  const url = letterboxd ? str(letterboxd.url) : null;
  return url ?? (fallbackId ? `https://boxd.it/${fallbackId}` : "");
}

export function toDiaryEntry(entry: unknown): DiaryEntry {
  const e = unwrap(entry);
  const details = rec(e.diaryDetails) ?? {};
  const review = rec(e.review);
  const trimmed = trimReview(reviewText(e.review));
  const id = str(e.id) ?? "";
  return {
    id,
    film: toFilmBrief(e.film ?? e.production ?? {}),
    watchedOn: str(details.diaryDate),
    rewatch: details.rewatch === true,
    rating: num(e.rating),
    liked: e.like === true || e.liked === true,
    review: trimmed.text,
    reviewTruncated: trimmed.truncated,
    containsSpoilers: review?.containsSpoilers === true,
    tags: tagsOf(e),
    createdAt: str(e.whenCreated),
    url: entryUrl(e, id),
  };
}

export function toActivityItem(item: unknown): ActivityItem {
  const i = unwrap(item);
  const member = rec(i.member) ?? rec(i.owner) ?? rec(i.user) ?? {};
  const details = rec(i.diaryDetails) ?? {};
  const review = reviewText(i.review);
  const type =
    str(i.type) ??
    (review ? "review" : details.diaryDate ? "diary" : num(i.rating) !== null ? "rating" : "activity");
  return {
    member: {
      id: str(member.id) ?? "",
      username: str(member.username) ?? "",
      displayName: str(member.displayName) ?? str(member.name),
    },
    type,
    film: toFilmBrief(i.film ?? i.production ?? {}),
    rating: num(i.rating),
    liked: i.like === true || i.liked === true,
    rewatch: details.rewatch === true,
    watchedOn: str(details.diaryDate),
    reviewSnippet: trimReview(review, 280).text,
    when: str(i.whenCreated) ?? str(i.when),
  };
}
