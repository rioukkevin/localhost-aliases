/**
 * The one error type the API layer adds on top of core's `ValidationError`.
 * Kept in its own module so `service.ts` (business logic) and `http.ts` (transport)
 * can both depend on it without depending on each other.
 */

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Core signals a missing alias with a plain `Error`; re-tag it so HTTP can answer 404. */
export function asNotFound(error: unknown): unknown {
  if (error instanceof Error && /not found/i.test(error.message)) {
    return new NotFoundError(error.message);
  }
  return error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
