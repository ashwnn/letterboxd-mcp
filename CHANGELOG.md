# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-24

### Added

- Remote MCP server on Cloudflare Workers using `wrangler` v4, TypeScript strict, Hono, and zod.
- Stateless MCP endpoint at `/mcp` built with `agents` and the `@modelcontextprotocol/server` v2 `createMcpHandler`.
- OAuth 2.1 authorization server via `@cloudflare/workers-oauth-provider` 1.1.0: PKCE `S256`, DCR + CIMD, resource indicators, and audience-bound tokens.
- Single-owner login using `ADMIN_PASSWORD`, with constant-time comparison, a KV counter, and the `LOGIN_LIMITER` rate limit.
- Letterboxd OAuth link flow with tokens stored in the `LetterboxdTokenStore` Durable Object (`LB_TOKENS`); refresh tokens never leave it.
- `/letterboxd/relink` (password protected) and `POST /letterboxd/unlink` endpoints for link recovery and removal.
- Read tools: `whoami`, `get_diary`, `get_log_entry`, `find_films`, `get_watchlist`, `get_member_stats`, `search_films`, `get_film`, `get_my_film_status`, `get_friends_activity`, `get_friends_on_film`, `get_following`.
- Write tools gated on the `letterboxd:write` scope and the `READ_ONLY` kill switch: `log_film`, `set_film_status`, `update_log_entry`, `delete_log_entry`.
- Configuration: KV namespaces `OAUTH_KV` and `LOOKUP_KV`, Durable Object `LB_TOKENS`, rate limit `LOGIN_LIMITER`, and vars `PUBLIC_URL`, `TIMEZONE`, `READ_ONLY`, `ALLOWED_REDIRECT_HOSTS`, `ENVIRONMENT`.
- Offline test suite using vitest and `@cloudflare/vitest-pool-workers`, plus `npm run typecheck`.

### Notes

- Awaiting Letterboxd API access: email api@letterboxd.com with the project title in the subject (https://letterboxd.com/api-beta/). Letterboxd is currently not granting access for LLM/GPT-related or private/personal projects, so approval is uncertain. The project runs without live credentials in tests.
- Redirect hosts are allowlisted (`claude.ai`, `claude.com`, `chatgpt.com`; `localhost` only when `ENVIRONMENT=dev`).
- No scraping of letterboxd.com beyond the documented HEAD ID lookups.
- v1 non-goals: multi-user support, lists management, comments, profile editing, following/unfollowing, and a local stdio build.
- Uses the older `/film/*` Letterboxd API endpoints rather than the newer `/production/*` ones. Smart Placement is not enabled.
