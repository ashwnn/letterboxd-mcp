# letterboxd-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io/) server for [Letterboxd](https://letterboxd.com/), running on Cloudflare Workers. It ships its own OAuth 2.1 authorization server (single owner password), uses the official Letterboxd API, and works offline in tests without live Letterboxd credentials.

Version: `0.1.0`

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Letterboxd API access](#letterboxd-api-access)
- [Deploy](#deploy)
- [Local development](#local-development)
- [Connecting a client](#connecting-a-client)
- [Relinking and unlinking](#relinking-and-unlinking)
- [Tools](#tools)
- [Example prompts](#example-prompts)
- [Configuration](#configuration)
- [Security](#security)
- [Testing](#testing)
- [Known limitations](#known-limitations)

## What it does

- Exposes a stateless MCP endpoint at `https://<host>/mcp`.
- Acts as an OAuth 2.1 authorization server: PKCE `S256`, Dynamic Client Registration (DCR) and Client ID Metadata Documents (CIMD), and resource indicators (audience-bound tokens).
- Login is a single owner password (`ADMIN_PASSWORD`).
- Links one Letterboxd account through Letterboxd OAuth; tokens are kept server-side.
- Read tools cover diary, films, watchlist, and friends; write tools are registered only when the `letterboxd:write` scope was granted and `READ_ONLY` is not `"true"`.
- Never scrapes letterboxd.com; only the documented HEAD ID lookups are used.

## Architecture

- Entry point `src/index.ts` (wrangler `main`), deployed with `wrangler` v4.
- MCP handling: `agents` + `@modelcontextprotocol/server` v2 stateless `createMcpHandler`.
- OAuth 2.1 authorization server: `@cloudflare/workers-oauth-provider` `1.1.0`.
- HTTP routes: Hono. Validation: zod. TypeScript strict.
- Letterboxd access/refresh tokens live in the `LetterboxdTokenStore` Durable Object (`LB_TOKENS` binding); refresh tokens never leave it.
- OAuth AS state lives in the `OAUTH_KV` KV namespace; `LOOKUP_KV` is a secondary KV namespace used by the Worker for lookups.
- `LOGIN_LIMITER` rate-limits the owner login.
- Tools return compact JSON text.

This README documents the v0.1.0 behavior. `src/` is under active development; tool schemas and route internals are defined there.

## Letterboxd API access

This project uses the official Letterboxd API. Request access by emailing [api@letterboxd.com](mailto:api@letterboxd.com) with the project title in the subject line; details are on the [Letterboxd API beta page](https://letterboxd.com/api-beta/).

Letterboxd is currently not granting API access for LLM/GPT-related or private/personal projects, so approval is uncertain. The project is built to run its test suite entirely offline, without live credentials, so you can develop and self-test while waiting.

## Deploy

Prerequisites: a Cloudflare account (Workers, KV, Durable Objects) and an approved Letterboxd API key.

```bash
git clone git@github.com:ashwnn/letterboxd-mcp.git
cd letterboxd-mcp
npm install
```

Create the two KV namespaces:

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create LOOKUP_KV
```

Paste the returned ids into `kv_namespaces` in `wrangler.jsonc`, then set `vars.PUBLIC_URL` to the origin the Worker will be served from (it must match the deployed host), for example `https://letterboxd-mcp.<account>.workers.dev`.

Set the secrets:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put LETTERBOXD_CLIENT_ID
npx wrangler secret put LETTERBOXD_CLIENT_SECRET
npx wrangler secret put COOKIE_SIGNING_KEY   # required for the relink flow
```

Deploy:

```bash
npm run deploy
```

Finally, register `https://<host>/letterboxd/callback` as the redirect URI for your Letterboxd API key.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the values; .dev.vars is gitignored
npm run dev                      # wrangler dev, serves http://localhost:8787
npx @modelcontextprotocol/inspector
```

Point MCP Inspector at `http://localhost:8787/mcp`. Localhost redirects are only allowed when `ENVIRONMENT=dev`, so uncomment the local overrides (`PUBLIC_URL`, `ENVIRONMENT`) in `.dev.vars` for browser-based OAuth flows.

## Connecting a client

Both clients use the same MCP URL, `https://<host>/mcp`:

- **Claude**: Settings → Connectors → Add custom connector, then enter the URL.
- **ChatGPT**: enable developer mode and add a connector with the same URL.

During authorization you will be asked for `ADMIN_PASSWORD`. If no Letterboxd account is linked yet, the flow redirects to Letterboxd so you can link it. Connections use PKCE `S256`, DCR + CIMD, and resource indicators, with tokens audience-bound to this server.

## Relinking and unlinking

- `https://<host>/letterboxd/relink` (password protected): use when the Letterboxd refresh token was revoked. It starts a Letterboxd authorization with a signed, single-use `state`; the callback refuses a state that was not started in the same browser. Re-authorizing any connector also re-links when no healthy link exists.
- `POST /letterboxd/unlink`: removes the Letterboxd link (password protected; form field `password`).
- When the link is broken, tools answer with a message pointing at the relink URL.

## Tools

Read tools (granted with `letterboxd:read`, which is the default):

| Group | Tool | Purpose |
| --- | --- | --- |
| History | `whoami` | Identify the linked Letterboxd account. |
| History | `get_diary` | Recent diary entries. |
| History | `get_log_entry` | Fetch a single log entry. |
| History | `find_films` | Resolve films by title or id. |
| History | `get_watchlist` | List the watchlist. |
| History | `get_member_stats` | Member statistics. |
| Films | `search_films` | Search the film catalog. |
| Films | `get_film` | Film details. |
| Films | `get_my_film_status` | Your watch/like/rating status for a film. |
| Friends | `get_friends_activity` | Recent activity from friends. |
| Friends | `get_friends_on_film` | Friends who have seen a film, with their ratings. |
| Friends | `get_following` | Accounts you follow. |

Write tools are registered only when the `letterboxd:write` scope was granted and `READ_ONLY` is not `"true"`:

| Tool | Purpose |
| --- | --- |
| `log_film` | Log a film (date, rating, like, review). |
| `set_film_status` | Set watchlist/liked/watched status. |
| `update_log_entry` | Update an existing log entry. |
| `delete_log_entry` | Delete a log entry. |

Tool parameters and output fields are defined in `src/`.

## Example prompts

- "What did I watch last month and how did I rate it?"
- "Log Anora for yesterday, 4.5 stars, liked"
- "Which of my friends have seen The Brutalist and what did they think?"
- "Pick something under 100 minutes from my watchlist"

## Configuration

### Vars (`wrangler.jsonc`)

| Name | Default | Description |
| --- | --- | --- |
| `PUBLIC_URL` | `https://letterboxd-mcp.<account>.workers.dev` | Public origin of the Worker; used for OAuth metadata and redirects. Must match the deployed host. |
| `TIMEZONE` | `America/Vancouver` | IANA timezone used to resolve dates for diary and logging. |
| `READ_ONLY` | `false` | `"true"` disables write tools and the `letterboxd:write` scope. |
| `ALLOWED_REDIRECT_HOSTS` | `claude.ai,claude.com,chatgpt.com` | Comma-separated allowlist of OAuth redirect hosts. `localhost` is allowed only when `ENVIRONMENT=dev`. |
| `ENVIRONMENT` | `production` | `production`, `dev`, or `test`; controls the localhost redirect allowance. |

### Secrets (`npx wrangler secret put <NAME>`)

| Name | Required | Description |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Yes | Owner password for the login step of the OAuth flow. |
| `LETTERBOXD_CLIENT_ID` | Yes | Letterboxd API client id. |
| `LETTERBOXD_CLIENT_SECRET` | Yes | Letterboxd API client secret. |
| `COOKIE_SIGNING_KEY` | Yes (for relinking) | HMAC key (32+ random bytes) for the `/letterboxd/relink` CSRF cookie. Relinking fails without it; the rest of the server still works. |

Local development uses `.dev.vars` (gitignored, see `.dev.vars.example`).

### Bindings (`wrangler.jsonc`)

| Binding | Type | Description |
| --- | --- | --- |
| `OAUTH_KV` | KV namespace | OAuth 2.1 authorization server state. |
| `LOOKUP_KV` | KV namespace | Secondary KV namespace used by the Worker for lookups. |
| `LB_TOKENS` | Durable Object (`LetterboxdTokenStore`) | Stores Letterboxd tokens and performs refreshes. |
| `LOGIN_LIMITER` | Rate limit | Limits owner login attempts (5 per 60 seconds, per Cloudflare location). |

## Security

- The owner password is a Worker secret, compared in constant time and rate limited.
- OAuth redirect hosts are allowlisted (`claude.ai`, `claude.com`, `chatgpt.com`; `localhost` only when `ENVIRONMENT=dev`).
- PKCE `S256` only; DCR + CIMD; resource indicators, so tokens are audience-bound.
- Letterboxd tokens live in the `LetterboxdTokenStore` Durable Object; refresh tokens never leave it.
- Write tools are scope-gated (`letterboxd:write`) and disabled by the `READ_ONLY` kill switch.
- CSRF and consent are handled by the OAuth provider library helpers.
- No scraping of letterboxd.com; only the documented HEAD ID lookups are used.

## Testing

```bash
npm test          # whole suite, offline, inside workerd via @cloudflare/vitest-pool-workers
npm run typecheck # tsc --noEmit
```

The suite needs no live Letterboxd credentials.

## Known limitations

Non-goals for v1 (not implemented):

- Multi-user support (this server is single-owner).
- Lists management, comments, profile editing, and following/unfollowing.
- A local stdio build; the server is remote HTTP only.

Other constraints:

- The read-only letterboxd.com lookup is limited to documented HEAD ID lookups; no page scraping.
- The older `/film/*` API endpoints are used rather than the newer `/production/*` endpoints.
- Smart Placement is not enabled.
- Tool results are compact JSON text, not rich structured content.
- Login limiting is per Cloudflare location (`LOGIN_LIMITER`) plus a KV counter, not a single global limit.
