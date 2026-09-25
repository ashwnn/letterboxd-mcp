const STYLE = `
  :root { color-scheme: light; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid;
    place-items: center; background: #f4f4f2; color: #1c1c1c; }
  main { width: min(26rem, calc(100% - 2rem)); background: #fff; border: 1px solid #ddd;
    border-radius: 10px; padding: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { margin: 0.5rem 0; }
  code { background: #f0f0ee; padding: 0.1rem 0.3rem; border-radius: 4px; }
  label { display: block; margin: 0.75rem 0; }
  fieldset { border: 1px solid #ddd; border-radius: 6px; margin: 0.75rem 0; }
  label.scope { margin: 0.25rem 0; }
  input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.45rem;
    margin-top: 0.25rem; border: 1px solid #bbb; border-radius: 6px; }
  .actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
  button { padding: 0.5rem 1rem; border: 1px solid #1c1c1c; border-radius: 6px;
    background: #1c1c1c; color: #fff; cursor: pointer; }
  button.secondary { background: #fff; color: #1c1c1c; }
  .error { color: #a00; }
  .ok { color: #087443; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>${body}</main>
</body>
</html>
`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * HTML response with the app's fixed security headers. Any headers passed in
 * (e.g. the consent binding cookie from beginConsent) are preserved; a
 * Content-Security-Policy they already carry is kept and extended.
 */
export function htmlResponse(
  html: string,
  headers?: Headers,
  status = 200,
): Response {
  const merged = new Headers(headers);
  merged.set("Content-Type", "text/html; charset=utf-8");
  merged.set("Referrer-Policy", "no-referrer");
  merged.set("X-Frame-Options", "DENY");
  merged.set("Cache-Control", "no-store");
  const csp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";
  const existing = merged.get("Content-Security-Policy");
  merged.set("Content-Security-Policy", existing ? `${existing}; ${csp}` : csp);
  return new Response(html, { status, headers: merged });
}

export function errorPage(message: string): string {
  return page(
    "Error",
    `<h1>Error</h1><p class="error">${escapeHtml(message)}</p>`,
  );
}

export interface HomePageOptions {
  linked?: boolean;
  unlinked?: boolean;
}

export function homePage(mcpUrl: string, options: HomePageOptions = {}): string {
  const banner = options.linked
    ? `<p class="ok">Letterboxd reconnected.</p>`
    : options.unlinked
      ? `<p class="ok">Letterboxd unlinked.</p>`
      : "";
  return page(
    "Letterboxd MCP",
    `<h1>Letterboxd MCP</h1>
${banner}
<p>Connect at <code>${escapeHtml(mcpUrl)}</code></p>
<details>
<summary>Manage connection</summary>
<form method="post" action="/letterboxd/unlink">
<label>Admin password <input type="password" name="password" required autocomplete="current-password"></label>
<button type="submit">Unlink Letterboxd</button>
</form>
<p><a href="/letterboxd/relink">Reconnect Letterboxd</a></p>
</details>`,
  );
}

export interface ConsentPageOptions {
  clientName: string;
  redirectHost: string;
  scopes: string[];
  handle: string;
  error?: string;
}

/**
 * Consent page. Posts to the same URL (the authorize endpoint, query string
 * included) with no action attribute, as the binding handle expects.
 */
export function consentPage(options: ConsentPageOptions): string {
  const error = options.error
    ? `<p class="error">${escapeHtml(options.error)}</p>`
    : "";
  const scopes = options.scopes
    .map(
      (scope) =>
        `<label class="scope"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`,
    )
    .join("\n");
  return page(
    "Authorize access",
    `<h1>Authorize access</h1>
${error}
<p><strong>${escapeHtml(options.clientName)}</strong> wants to connect to your Letterboxd account and will return to <code>${escapeHtml(options.redirectHost)}</code>.</p>
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(options.handle)}">
<fieldset><legend>Permissions</legend>
${scopes}
</fieldset>
<label>Admin password <input type="password" name="password" required autocomplete="current-password"></label>
<div class="actions">
<button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</div>
</form>`,
  );
}

export interface RelinkPageOptions {
  error?: string;
}

export function relinkPage(options: RelinkPageOptions = {}): string {
  const error = options.error
    ? `<p class="error">${escapeHtml(options.error)}</p>`
    : "";
  return page(
    "Reconnect Letterboxd",
    `<h1>Reconnect Letterboxd</h1>
${error}
<p>Sign in to start a fresh Letterboxd connection.</p>
<form method="post" action="/letterboxd/relink">
<label>Admin password <input type="password" name="password" required autocomplete="current-password"></label>
<div class="actions"><button type="submit">Connect Letterboxd</button></div>
</form>`,
  );
}
