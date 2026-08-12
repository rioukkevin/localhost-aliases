/**
 * Transport helpers: JSON in, JSON out, and one place that decides which HTTP
 * status a thrown error deserves. Route handlers stay three lines long because
 * of this file.
 */
import type { ValidationIssue } from "@localhost-aliases/core";
import { NotFoundError } from "./errors.ts";

export function json(data: unknown, status = 200): Response {
  // A control panel must never be cached: every response reflects live state.
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export function problem(error: string, status: number, issues?: ValidationIssue[]): Response {
  return json({ error, ...(issues && issues.length > 0 ? { issues } : {}) }, status);
}

/**
 * `instanceof` alone is not reliable here: Next may bundle `@localhost-aliases/core`
 * more than once, which gives ValidationError more than one class identity. The
 * structural check is what actually holds.
 */
function validationIssues(error: unknown): ValidationIssue[] | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { name?: unknown; issues?: unknown };
  if (candidate.name !== "ValidationError" || !Array.isArray(candidate.issues)) return null;
  return candidate.issues as ValidationIssue[];
}

function isNotFound(error: unknown): boolean {
  if (error instanceof NotFoundError) return true;
  return error instanceof Error && error.name === "NotFoundError";
}

/**
 * Maps a thrown error to a response. Validation failures are the user's problem
 * (400 + field-level issues), a missing entity is 404, everything else is ours:
 * logged in full server-side, generic to the client so we never leak internals.
 */
export function toErrorResponse(error: unknown): Response {
  const issues = validationIssues(error);
  if (issues) {
    return problem("The request could not be validated.", 400, issues);
  }
  if (isNotFound(error)) {
    return problem(error instanceof Error ? error.message : "Not found.", 404);
  }
  console.error("[api] unhandled error:", error);
  return problem("Internal server error.", 500);
}

/** Wraps a route handler body so no handler ever needs its own try/catch. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    return toErrorResponse(error);
  }
}
