/**
 * Upstream error types. They live in their own module so the Durable Object and
 * the client can both import them without a circular dependency, and so the
 * client can re-export them as part of its public surface.
 */

export class LetterboxdApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "LetterboxdApiError";
    this.status = status;
    this.code = code;
  }
}

/** Thrown when a member token is required but no healthy Letterboxd link exists. */
export class LetterboxdNotLinkedError extends Error {
  constructor(message = "No Letterboxd account is linked.") {
    super(message);
    this.name = "LetterboxdNotLinkedError";
  }
}

/**
 * Durable Object RPC serializes errors, so a class thrown inside the DO arrives
 * as a plain Error with the same name. Rebuild it on the caller's side so
 * `instanceof` checks keep working across the RPC boundary.
 */
export function rebuildRpcError(error: unknown): never {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    const message = (error as Error).message;
    if (name === "LetterboxdNotLinkedError") {
      throw new LetterboxdNotLinkedError(message);
    }
    if (name === "LetterboxdApiError") {
      const typed = error as LetterboxdApiError;
      throw new LetterboxdApiError(typed.status ?? 0, message, typed.code);
    }
  }
  throw error;
}
