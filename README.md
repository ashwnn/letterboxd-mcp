# Letterboxd MCP

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ashwnn/letterboxd-mcp)

A remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for [Letterboxd](https://letterboxd.com/), built with Cloudflare Workers. It provides read access to your Letterboxd account and optional write tools through the official Letterboxd API.

> **API access required for live Letterboxd data.** Letterboxd API access is currently limited and approval is uncertain, especially for LLM-related or personal projects. Request access at the [Letterboxd API beta page](https://letterboxd.com/api-beta/) before expecting account linking to work. The test suite runs offline without API credentials.

## Deploy to Cloudflare

Click **Deploy to Cloudflare** above. Cloudflare will copy the public repository into your GitHub account, provision supported Worker resources, and build and deploy it to your Cloudflare account.

During setup, provide:

- A strong `ADMIN_PASSWORD` for the owner login.
- Your Letterboxd API `LETTERBOXD_CLIENT_ID` and `LETTERBOXD_CLIENT_SECRET` (available after API access is approved).
- A random `COOKIE_SIGNING_KEY` of at least 32 bytes. Generate one with `openssl rand -hex 32`.

After the first deployment:

1. Confirm the Worker’s `PUBLIC_URL` matches its deployed `https://<worker>.<your-subdomain>.workers.dev` address. Update it in the copied repository’s `wrangler.jsonc` and redeploy if needed.
2. Add `https://<worker-host>/letterboxd/callback` as the redirect URI for your Letterboxd API client.
3. Open `https://<worker-host>/mcp` in your MCP client to connect.

Cloudflare’s deploy flow provisions the declared KV namespaces and Durable Object binding. It does not grant Letterboxd API access; account linking requires approved API credentials.

## Deploy it yourself

### Requirements

- Node.js 20 or newer and npm
- A Cloudflare account with Workers enabled
- Letterboxd API credentials for live account linking

### 1. Get the code and install dependencies

```bash
git clone https://github.com/ashwnn/letterboxd-mcp.git
cd letterboxd-mcp
npm ci
npx wrangler login
```

### 2. Create the KV namespaces

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler kv namespace create LOOKUP_KV
```

Copy each command’s returned ID into the matching `id` in `kv_namespaces` in `wrangler.jsonc`. Keep the binding names unchanged.

### 3. Set the public URL and secrets

Enable a `workers.dev` subdomain in the Cloudflare dashboard if you have not already. Set `vars.PUBLIC_URL` in `wrangler.jsonc` to the Worker’s exact public origin, for example:

```text
https://letterboxd-mcp.<your-subdomain>.workers.dev
```

Set the secrets:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put LETTERBOXD_CLIENT_ID
npx wrangler secret put LETTERBOXD_CLIENT_SECRET
npx wrangler secret put COOKIE_SIGNING_KEY
```

Use a unique strong password and a random signing key. Do not put production secrets in `wrangler.jsonc` or commit `.dev.vars`.

### 4. Deploy and register the callback

```bash
npm run deploy
```

Register `https://<worker-host>/letterboxd/callback` as the redirect URI in your Letterboxd API client settings.

## Run locally

```bash
git clone https://github.com/ashwnn/letterboxd-mcp.git
cd letterboxd-mcp
npm ci
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` with local values, then run:

```bash
npm run dev
```

The local Worker is served at `http://localhost:8787`. For browser-based OAuth testing, set these local overrides in `.dev.vars`:

```dotenv
PUBLIC_URL="http://localhost:8787"
ENVIRONMENT="dev"
```

Use [MCP Inspector](https://github.com/modelcontextprotocol/inspector) and connect it to `http://localhost:8787/mcp`.

## What it provides

- A stateless MCP endpoint at `/mcp` and an OAuth 2.1 authorization server.
- A single owner password gate, PKCE S256, Dynamic Client Registration, Client ID Metadata Documents, and audience-bound tokens.
- Server-side Letterboxd OAuth tokens stored in a Durable Object.
- Read tools for diary, films, watchlist, member stats, and friends.
- Optional write tools gated by the `letterboxd:write` scope and the `READ_ONLY` setting.
- No Letterboxd page scraping. The project uses the official API and documented HEAD ID lookups.

## Available tools

| Area | Tools |
| --- | --- |
| Account and history | `whoami`, `get_diary`, `get_log_entry`, `find_films`, `get_watchlist`, `get_member_stats` |
| Films | `search_films`, `get_film`, `get_my_film_status` |
| Friends | `get_friends_activity`, `get_friends_on_film`, `get_following` |
| Write (optional) | `log_film`, `set_film_status`, `update_log_entry`, `delete_log_entry` |

Write tools are available only when the Letterboxd authorization includes `letterboxd:write` and `READ_ONLY` is not `"true"`.

## Connect an MCP client

Use `https://<worker-host>/mcp` as the remote MCP URL.

- **Claude:** Settings → Connectors → Add custom connector.
- **ChatGPT:** Enable developer mode, then add a connector using the same URL.

The OAuth flow asks for the owner password. If no healthy Letterboxd account is linked, it redirects to Letterboxd to authorize the account.

## Configuration

### Worker variables

Set in `wrangler.jsonc`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_URL` | Placeholder Workers URL | Public origin used for OAuth metadata and redirects. Must match the deployed host. |
| `TIMEZONE` | `America/Vancouver` | Time zone used to resolve diary and logging dates. |
| `READ_ONLY` | `false` | Set to `"true"` to disable write tools. |
| `ALLOWED_REDIRECT_HOSTS` | `claude.ai,claude.com,chatgpt.com` | Allowed OAuth redirect hosts. |
| `ENVIRONMENT` | `production` | Set to `dev` to allow localhost redirects during local OAuth testing. |

### Secrets

Production values are configured with `wrangler secret put`. Local values go in the ignored `.dev.vars` file.

| Secret | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Yes | Password for the server owner’s authorization flow. |
| `LETTERBOXD_CLIENT_ID` | Yes | Client ID issued with Letterboxd API access. |
| `LETTERBOXD_CLIENT_SECRET` | Yes | Client secret issued with Letterboxd API access. |
| `COOKIE_SIGNING_KEY` | Yes for relinking | HMAC key for the browser-bound relink flow; use at least 32 random bytes. |

### Cloudflare bindings

The Wrangler config declares two KV namespaces, a `LetterboxdTokenStore` Durable Object, and a login rate limit binding. The Cloudflare deploy button provisions supported storage and Durable Object resources. For manual CLI deployment, create the KV namespaces and set their IDs as described above.

## Test and check

Tests run offline and do not require Letterboxd credentials:

```bash
npm test
npm run typecheck
```

To smoke-test a local or deployed server:

```bash
node scripts/smoke.mjs --base-url http://localhost:8787
node scripts/smoke.mjs --base-url https://<worker-host> --password "$ADMIN_PASSWORD"
```

Without `--password`, the smoke test stops at the consent page. If Letterboxd is not linked, it reports the redirect to Letterboxd and exits successfully. Use `--client-ip <ip>` to isolate repeat runs from the login rate limiter.

## Relink or unlink Letterboxd

- Open `https://<worker-host>/letterboxd/relink` to relink the Letterboxd account. This requires the owner password and `COOKIE_SIGNING_KEY`.
- Submit `POST /letterboxd/unlink` with the owner password to delete stored Letterboxd tokens.
- Letterboxd does not publish a token revocation endpoint. To revoke access upstream, remove the app from your Letterboxd account settings.

## Security notes

- Use unique production secrets. Never commit `.dev.vars`.
- The owner password is compared in constant time and login attempts are rate limited.
- OAuth redirect hosts are allowlisted; localhost is allowed only in the dev environment.
- MCP tokens are audience-bound, and upstream Letterboxd tokens stay in the Durable Object.
- Write operations require the write scope and can be disabled with `READ_ONLY="true"`.

## Limitations

- Single-owner server; no multi-user support.
- Remote HTTP only; no local stdio server.
- Lists management, comments, profile editing, and following/unfollowing are not implemented.
- v1 uses older `/film/*` endpoints, so TV shows are not supported.
- The upstream Letterboxd authorization flow uses browser-bound state; the MCP-facing flow enforces PKCE S256.
- Login limiting uses a Cloudflare rate limit binding plus a KV counter, not one global limit.

See [CHANGELOG.md](CHANGELOG.md) for release history.
