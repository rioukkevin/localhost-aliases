/**
 * Release notes are the GitHub release body: markdown, written by whoever cut the release —
 * or, once the workflow generates them, by a model reading the commit log. Either way it is
 * REMOTE INPUT rendered into a page.
 *
 * Rather than a markdown pipeline, this handles the five constructs release notes actually
 * use — headings, bullets, paragraphs, fenced code and rules — and hands every inline run to
 * the docs' renderer, which escapes everything (React) and refuses non-http hrefs. Fenced
 * code matters specifically: the publish step writes the checksum and the verify commands
 * inside ``` fences, and a parser that did not know about them would print the backticks and
 * reflow a shell command into prose.
 */
import { Inline } from "../docs/blocks.tsx";

export type NoteBlock =
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "p"; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" };

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const FENCE = /^(```|~~~)/;
const RULE = /^(---+|\*\*\*+|___+)$/;

/** Exported for testing: notes come off the network, so the parse is worth pinning down. */
export function parseNotes(notes: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];

  const flush = () => {
    if (items.length > 0) {
      blocks.push({ kind: "list", items });
      items = [];
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: "p", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  const lines = notes.split("\n");
  let inFence = false;
  let fence: string[] = [];

  for (const raw of lines) {
    // Inside a fence nothing is markup: a `# comment` in a shell snippet is a comment.
    if (inFence) {
      if (FENCE.test(raw.trim())) {
        const text = fence.join("\n").replace(/\s+$/, "");
        if (text !== "") blocks.push({ kind: "code", text });
        fence = [];
        inFence = false;
        continue;
      }
      fence.push(raw);
      continue;
    }

    const line = raw.trim();

    if (FENCE.test(line)) {
      flush();
      inFence = true;
      continue;
    }
    if (line === "") {
      flush();
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading?.[1] !== undefined) {
      flush();
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet?.[1] !== undefined) {
      if (paragraph.length > 0) flush();
      items.push(bullet[1]);
      continue;
    }

    if (items.length > 0) flush();
    paragraph.push(line);
  }

  // An unterminated fence still has content; print it rather than swallow it.
  if (inFence) {
    const text = fence.join("\n").replace(/\s+$/, "");
    if (text !== "") blocks.push({ kind: "code", text });
  }
  flush();

  return blocks;
}

export function ReleaseNotes({ notes }: { notes: string }) {
  const blocks = parseNotes(notes);
  if (blocks.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, i) => {
        if (block.kind === "heading") {
          return (
            <h3 className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint" key={i}>
              {block.text}
            </h3>
          );
        }
        if (block.kind === "rule") {
          return <hr className="border-0 border-t border-hairline" key={i} />;
        }
        if (block.kind === "code") {
          return (
            <div className="border border-hairline-strong bg-sunken" key={i}>
              <pre className="mono overflow-x-auto px-3 py-2.5 text-[12px] leading-relaxed text-ink">{block.text}</pre>
            </div>
          );
        }
        if (block.kind === "list") {
          return (
            <ul className="flex flex-col gap-2" key={i}>
              {block.items.map((item, j) => (
                <li className="flex gap-3 text-[13px] leading-relaxed text-muted" key={j}>
                  <span aria-hidden className="mt-[9px] h-px w-3 shrink-0 bg-hairline-strong" />
                  <span className="min-w-0">
                    <Inline text={item} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p className="text-[13px] leading-relaxed text-muted" key={i}>
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}
