/**
 * The only place that knows about HTTP status codes. Route handlers stay thin by
 * wrapping their body in `route()`: it turns a plain value into JSON and maps the
 * three error shapes the service layer can produce onto 400 / 404 / 500.
 */
import { ValidationError, type ValidationIssue } from "@localhost-aliases/core";

/** Thrown by the service when an id does not exist. Mapped to 404. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(data)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The dashboard is a live view of the machine; nothing here may be cached.
      "cache-control": "no-store",
    },
  });
}

export function problem(
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error, ...extra }, status);
}

function toResponse(result: unknown): Response {
  return result instanceof Response ? result : json(result ?? { ok: true });
}

/**
 * Wrap a handler body. Anything not deliberately mapped becomes a generic 500 and is
 * logged server-side: internal messages must never reach the browser.
 */
export function route<A extends unknown[]>(
  fn: (request: Request, ...args: A) => Promise<unknown> | unknown,
): (request: Request, ...args: A) => Promise<Response> {
  return async (request: Request, ...args: A) => {
    try {
      return toResponse(await fn(request, ...args));
    } catch (error) {
      if (error instanceof ValidationError) {
        return problem(400, error.message, { issues: error.issues });
      }
      if (error instanceof NotFoundError) {
        return problem(404, error.message);
      }
      console.error(`[api] ${request.method} ${new URL(request.url).pathname} failed:`, error);
      return problem(500, "Something went wrong. Check the app log for details.");
    }
  };
}

/** Parse a JSON request body, reporting malformed input as a 400 rather than a 500. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError([{ field: "body", message: "Body must be valid JSON." }]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError([{ field: "body", message: "Body must be a JSON object." }]);
  }
  return parsed as Record<string, unknown>;
}

export function issue(field: string, message: string): ValidationIssue {
  return { field, message };
}

export function invalid(field: string, message: string): ValidationError {
  return new ValidationError([issue(field, message)]);
}
