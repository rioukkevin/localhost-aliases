/**
 * Docs content model.
 *
 * Content is typed data, not MDX: a handful of block kinds is enough for these seven pages,
 * and it means the docs can be unit-tested (slugs unique, links resolve) instead of only
 * being looked at. The renderer lives in app/docs/blocks.tsx and knows nothing about the
 * subject matter.
 */

export type DocBlock =
  /** A paragraph. Inline markup: `code` and [label](href). */
  | { kind: "p"; text: string }
  /** Numbered steps, in order. */
  | { kind: "steps"; items: string[] }
  | { kind: "list"; items: string[] }
  /** A shell command or file body. Rendered verbatim, monospace, with a copy affordance. */
  | { kind: "code"; label?: string; value: string }
  /** Pre-formatted ASCII figure: no copy button, no wrapping. */
  | { kind: "figure"; value: string; caption?: string }
  | { kind: "note"; tone: "info" | "warn" | "danger"; title: string; text: string }
  | { kind: "table"; head: string[]; rows: string[][] };

export interface DocSection {
  /** Anchor id; must be unique within its page. */
  id: string;
  title: string;
  blocks: DocBlock[];
}

export interface DocPage {
  slug: string;
  title: string;
  /** One-line summary, used as the lede, the index card body and the meta description. */
  lede: string;
  sections: DocSection[];
}

// --- inline markup ----------------------------------------------------------

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;

/**
 * Splits a string into text, `code`, **strong** and [label](href) runs. Deliberately tiny —
 * anything that needs more than this belongs in its own block kind.
 */
export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) tokens.push({ kind: "text", text: text.slice(last, at) });
    if (match[1] !== undefined) {
      tokens.push({ kind: "code", text: match[1] });
    } else if (match[2] !== undefined && match[3] !== undefined) {
      tokens.push({ kind: "link", text: match[2], href: match[3] });
    } else if (match[4] !== undefined) {
      tokens.push({ kind: "strong", text: match[4] });
    }
    last = at + match[0].length;
  }

  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}

/** Every inline href in a page, for link checking. */
export function pageLinks(page: DocPage): string[] {
  const hrefs: string[] = [];
  const scan = (text: string) => {
    for (const token of tokenizeInline(text)) {
      if (token.kind === "link") hrefs.push(token.href);
    }
  };

  for (const section of page.sections) {
    for (const block of section.blocks) {
      switch (block.kind) {
        case "p":
          scan(block.text);
          break;
        case "steps":
        case "list":
          block.items.forEach(scan);
          break;
        case "note":
          scan(block.text);
          break;
        case "table":
          block.rows.forEach((row) => row.forEach(scan));
          break;
        default:
          break;
      }
    }
  }
  return hrefs;
}
