import type { Env } from "../env";

const MAX_FAILURES = 5;
const FAILURE_WINDOW_SECONDS = 900;

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

/** Both inputs are SHA-256 digests, so lengths always match. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * False when ADMIN_PASSWORD is unset. Never logs the submitted value.
 *
 * SHA-256 is used here only to make both sides equal length for the constant-time
 * compare; it is not password hashing. ADMIN_PASSWORD must stay a high-entropy
 * secret, not a guessable passphrase.
 */
export async function verifyPassword(
  env: Env,
  submitted: string,
): Promise<boolean> {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) return false;
  const [expectedDigest, submittedDigest] = await Promise.all([
    sha256(expected),
    sha256(submitted),
  ]);
  return constantTimeEqual(expectedDigest, submittedDigest);
}

function failureKey(ip: string): string {
  return `login-fail:${ip}`;
}

/** True when the caller must be turned away before any password check. */
export async function loginRateLimited(env: Env, ip: string): Promise<boolean> {
  if (env.LOGIN_LIMITER) {
    const outcome = await env.LOGIN_LIMITER.limit({ key: ip });
    if (!outcome.success) return true;
  }
  const failures = Number((await env.OAUTH_KV.get(failureKey(ip))) ?? "0");
  return failures >= MAX_FAILURES;
}

export async function recordLoginFailure(env: Env, ip: string): Promise<void> {
  // ponytail: KV read-modify-write is not atomic; parallel failures can
  // undercount by one. Good enough for login throttling, move to a DO if not.
  const key = failureKey(ip);
  const failures = Number((await env.OAUTH_KV.get(key)) ?? "0");
  await env.OAUTH_KV.put(key, String(failures + 1), {
    expirationTtl: FAILURE_WINDOW_SECONDS,
  });
}
