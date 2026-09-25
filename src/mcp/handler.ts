import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import {
  LetterboxdApiError,
  LetterboxdNotLinkedError,
  lbPaginate,
  lbRequest,
} from "../upstream/client";
import { SCOPE_WRITE, VERSION, isReadOnly, type AuthProps, type Env } from "../env";
import { registerFilmTools } from "./tools/films";
import { registerHistoryTools } from "./tools/history";
import { registerSocialTools } from "./tools/social";
import { registerWriteTools } from "./tools/write";

/** Shared per-request context handed to every tool registrar. */
export interface ToolDeps {
  env: Env;
  scopes: string[];
  canWrite: boolean;
}

export type QueryValue = string | number | boolean | undefined | (string | number)[];
export type Query = Record<string, QueryValue>;

export interface ListResult<T = unknown> {
  items: T[];
  nextCursor: string | null;
  count: number;
  truncated: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * Casts a raw API value to whatever input type an upstream formatter declares.
 * The formatters own their input types, so the tool layer stays decoupled.
 */
export function asParam<T>(value: unknown): T {
  return value as T;
}

function nextCursorOf(next: unknown): string | null {
  if (typeof next !== "string" || next.length === 0) return null;
  try {
    const cursor = new URL(next).searchParams.get("cursor");
    if (cursor) return cursor;
  } catch {
    // Not a URL: the value itself is the cursor.
  }
  return next;
}

/**
 * One page with an explicit cursor, otherwise lbPaginate aggregates pages.
 * ponytail: per-page vs aggregate semantics are delegated to lbPaginate.
 */
export async function requestPage<T = Record<string, unknown>>(
  env: Env,
  path: string,
  query: Query,
  options: { auth: "member" | "app" | "any"; cacheTtl?: number },
  cursor?: string,
): Promise<ListResult<T>> {
  if (cursor) {
    const page = await lbRequest<{ items?: unknown; next?: unknown }>(env, "GET", path, {
      query: { ...query, cursor },
      ...options,
    });
    const items = asRecords(page.items) as unknown as T[];
    return { items, nextCursor: nextCursorOf(page.next), count: items.length, truncated: false };
  }
  const page = await lbPaginate<T>(env, path, query, options);
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    count: page.items.length,
    truncated: page.truncated,
  };
}

export function ok(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

export function fail(env: Env, error: unknown) {
  if (error instanceof LetterboxdNotLinkedError) {
    return toolError(
      `Your Letterboxd link is not active. Visit ${env.PUBLIC_URL}/letterboxd/relink to reconnect.`,
    );
  }
  if (error instanceof LetterboxdApiError) return toolError(error.message);
  return toolError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
}

export function makeGuard(env: Env) {
  return async (fn: () => Promise<unknown>) => {
    try {
      return ok(await fn());
    } catch (error) {
      return fail(env, error);
    }
  };
}

function buildServer(env: Env): McpServer {
  const auth = getMcpAuthContext();
  const props = auth?.props as AuthProps | undefined;
  const scopes = Array.isArray(props?.scopes) ? props.scopes : [];
  const canWrite = scopes.includes(SCOPE_WRITE) && !isReadOnly(env);

  const server = new McpServer({ name: "letterboxd-mcp", version: VERSION });
  const deps: ToolDeps = { env, scopes, canWrite };
  registerHistoryTools(server, deps);
  registerFilmTools(server, deps);
  registerSocialTools(server, deps);
  if (canWrite) registerWriteTools(server, deps);
  return server;
}

export function createMcpApiHandler(): ExportedHandler<Env> {
  return {
    async fetch(request, env, ctx) {
      const handler = createMcpHandler(() => buildServer(env), {
        route: "/mcp",
        responseMode: "auto",
        allowedHostnames: [new URL(env.PUBLIC_URL).host],
      });
      return handler(request, env, ctx);
    },
  };
}
