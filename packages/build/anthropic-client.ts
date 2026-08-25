/**
 * The only file that talks to the Anthropic API.
 *
 * Everything above it depends on the `NotesClient` interface, never on `@anthropic-ai/sdk`, so
 * the release-notes logic can be unit-tested with no API key, no network and no bill. The same
 * shape `blob-upload.ts` uses for Vercel Blob.
 *
 * The request shape is deliberately narrow: `model`, `max_tokens`, `system` and one user
 * message. `temperature`, `top_p`, `top_k` and `thinking.budget_tokens` all return 400 on
 * claude-opus-5, and a type that cannot express them cannot accidentally send them.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface NotesRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user"; content: string }[];
}

/** A content block. `response.content` is a union — only `text` blocks carry `.text`. */
export interface NotesBlock {
  type: string;
  text?: string;
}

export interface NotesResponse {
  /** "end_turn" | "max_tokens" | "refusal" | … — never assume the happy one. */
  stop_reason: string | null;
  content: NotesBlock[];
}

export interface NotesClient {
  create(request: NotesRequest): Promise<NotesResponse>;
}

/**
 * Reads ANTHROPIC_API_KEY from the environment, as the SDK does by default. Callers decide
 * whether a key exists (see `hasApiKey`); this throws rather than sending an unauthenticated
 * request, and the caller treats that like any other failure: fall back, never fail the release.
 */
export function createNotesClient(): NotesClient {
  const client = new Anthropic();
  return {
    create: (request) => client.messages.create(request),
  };
}
