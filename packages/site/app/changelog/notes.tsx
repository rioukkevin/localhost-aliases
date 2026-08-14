/**
 * Release notes are markdown written by whoever cut the release. Rather than pull in a
 * markdown pipeline for the three constructs release notes actually use, this handles
 * headings, bullets and paragraphs, and hands each line to the docs' inline renderer —
 * which escapes everything (React) and refuses non-http hrefs.
 */
import { Inline } from "../docs/blocks.tsx";

type NoteBlock = { kind: "heading"; text: string } | { kind: "list"; items: string[] } | { kind: "p"; text: string };

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

  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined) {
      flush();
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet?.[1] !== undefined) {
      if (paragraph.length > 0) flush();
      items.push(bullet[1]);
      continue;
    }
    if (items.length > 0) flush();
    paragraph.push(line);
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
