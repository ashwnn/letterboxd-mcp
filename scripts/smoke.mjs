#!/usr/bin/env node
/**
 * Post-deploy smoke test for letterboxd-mcp. Dependency-free; run it against a
 * local `wrangler dev` server or a deployed Worker.
 *
 *   node scripts/smoke.mjs --base-url http://localhost:8787
 *   node scripts/smoke.mjs --base-url https://<host> --password "$ADMIN_PASSWORD"
 *
 * Without --password it stops at the consent page. With it, the script runs the
 * OAuth flow; if Letterboxd is not linked yet the server redirects to
 * Letterboxd and the script reports that a browser is needed to finish.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const baseUrl = (arg("--base-url", "http://localhost:8787") ?? "").replace(/\/$/, "");
const password = arg("--password", undefined);
const redirectUri = arg("--redirect-uri", "https://claude.ai/api/mcp/auth_callback");
// Optional: a fresh CF-Connecting-IP keeps repeated runs from tripping the login limiter.
const clientIp = arg("--client-ip", undefined);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function s256(verifier) {
  return base64Url(createHash("sha256").update(verifier).digest());
}

const jar = new Map();
function absorb(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    jar.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
  }
}
function cookieHeader() {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}
function extractHandle(html) {
  const match = /<input[^>]*name="handle"[^>]*value="([^"]+)"/i.exec(html);
  if (!match) throw new Error("no handle field on the consent page");
  return match[1];
}
async function postForm(pathOrUrl, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  if (clientIp) headers["cf-connecting-ip"] = clientIp;
  const target = pathOrUrl.startsWith("http") ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
  return fetch(target, { method: "POST", headers, body, redirect: "manual" });
}

async function main() {
  // 1. Authorization server metadata.
  const asMetadata = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
  check(
    "AS metadata advertises PKCE S256",
    (asMetadata.code_challenge_methods_supported ?? []).includes("S256"),
  );
  check(
    "AS metadata advertises CIMD",
    asMetadata.client_id_metadata_document_supported === true,
  );
  check(
    "AS metadata advertises both scopes",
    ["letterboxd:read", "letterboxd:write"].every((scope) =>
      (asMetadata.scopes_supported ?? []).includes(scope),
    ),
  );

  // 2. Protected resource metadata + challenge.
  const prm = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
  check("Protected resource metadata names /mcp", prm.resource === `${baseUrl}/mcp`, prm.resource);
  const unauth = await fetch(`${baseUrl}/mcp`, { redirect: "manual" });
  const challenge = unauth.headers.get("www-authenticate") ?? "";
  check("Unauthenticated /mcp returns 401", unauth.status === 401, `status ${unauth.status}`);
  check(
    "401 challenge points at the resource metadata",
    challenge.includes("resource_metadata=") &&
      challenge.includes("/.well-known/oauth-protected-resource"),
  );

  // 3. Dynamic client registration (Claude's path).
  const registration = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "smoke-test", redirect_uris: [redirectUri] }),
  });
  const client = await registration.json().catch(() => ({}));
  check("DCR returns a client id", registration.ok && typeof client.client_id === "string");
  if (typeof client.client_id !== "string") return finish();

  // 4. Consent page.
  const verifier = base64Url(randomBytes(32));
  const state = randomUUID();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: s256(verifier),
    code_challenge_method: "S256",
    resource: `${baseUrl}/mcp`,
    scope: "letterboxd:read letterboxd:write",
  });
  const authorizeUrl = `${baseUrl}/authorize?${params.toString()}`;
  const page = await fetch(authorizeUrl, { redirect: "manual" });
  absorb(page);
  const html = await page.text();
  const renders = page.status === 200 && html.includes("handle");
  const pageText = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  check(
    "Consent page renders",
    renders,
    renders ? "" : `status ${page.status}${pageText ? `: ${pageText}` : ""}`,
  );
  if (!renders) return finish();
  const handle = extractHandle(html);
  check("Consent page names the client", html.includes("smoke-test"));
  check("Consent page shows the redirect host", html.includes(new URL(redirectUri).hostname));

  if (!password) {
    console.log("SKIP  OAuth flow (pass --password to run it)");
    return finish();
  }

  // 5. Wrong password is refused.
  const wrong = await postForm(authorizeUrl, {
    handle,
    password: "definitely-not-the-password",
    decision: "approve",
  });
  check("Wrong password is refused", wrong.status === 401, `status ${wrong.status}`);
  absorb(wrong);
  const retryHtml = await wrong.text();
  const retryHandle = retryHtml.includes("handle") ? extractHandle(retryHtml) : handle;

  // 6. Correct password completes the grant or starts the Letterboxd link.
  const approved = await postForm(authorizeUrl, {
    handle: retryHandle,
    password,
    decision: "approve",
    scope: "letterboxd:read",
  });
  check("Correct password redirects", approved.status === 302, `status ${approved.status}`);
  const location = new URL(approved.headers.get("location") ?? "about:blank");
  if (location.hostname === "api.letterboxd.com") {
    console.log(
      "INFO  Letterboxd is not linked: the flow redirects to Letterboxd. " +
        "Finish the link in a browser, then run the script again to check tokens and tools.",
    );
    return finish();
  }
  check("Grant redirects to the client callback", location.href.startsWith(redirectUri), location.href);
  const code = location.searchParams.get("code");
  check("Redirect carries an authorization code", Boolean(code));

  const tokenResponse = await postForm("/token", {
    grant_type: "authorization_code",
    code: code ?? "",
    redirect_uri: redirectUri,
    client_id: client.client_id,
    client_secret: client.client_secret ?? "",
    code_verifier: verifier,
    resource: `${baseUrl}/mcp`,
  });
  const tokenBody = await tokenResponse.json().catch(() => ({}));
  check("Token exchange succeeds", tokenResponse.ok && typeof tokenBody.access_token === "string");
  if (typeof tokenBody.access_token !== "string") return finish();

  const mcp = async (method, params) =>
    (
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json();

  const initialized = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.1.0" },
  });
  check("MCP initialize succeeds", !initialized.error, initialized.error?.message);
  const listed = await mcp("tools/list", {});
  const names = (listed.result?.tools ?? []).map((tool) => tool.name);
  check("tools/list returns the catalog", names.length >= 12, `${names.length} tools`);
  check("Read tools are present", names.includes("get_diary") && names.includes("get_film"));
  check("Write tools follow the granted scope", !names.includes("log_film"), "read-only grant");

  return finish();
}

function finish() {
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`Smoke test crashed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
