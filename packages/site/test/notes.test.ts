/**
 * The release-notes parser. The input is a GitHub release body — remote text — and the
 * publish step's own body contains fenced code, a rule and a heading, so the parse is worth
 * pinning down rather than eyeballing once.
 */
import { describe, expect, test } from "bun:test";
import { parseNotes } from "../app/changelog/notes.tsx";

describe("parseNotes", () => {
  test("empty notes produce no blocks at all, so the section can be omitted", () => {
    expect(parseNotes("")).toEqual([]);
    expect(parseNotes("\n\n   \n")).toEqual([]);
  });

  test("headings, bullets and paragraphs", () => {
    const blocks = parseNotes("## Added\n\n- One thing\n- Another\n\nA closing sentence.\n");
    expect(blocks).toEqual([
      { kind: "heading", text: "Added" },
      { kind: "list", items: ["One thing", "Another"] },
      { kind: "p", text: "A closing sentence." },
    ]);
  });

  test("consecutive prose lines join into one paragraph", () => {
    expect(parseNotes("one line\nand its continuation")).toEqual([
      { kind: "p", text: "one line and its continuation" },
    ]);
  });

  test("the body the publish step actually writes", () => {
    const body = [
      "### Changes since v1.9.0",
      "",
      "- Raw TCP forwarding",
      "",
      "---",
      "",
      "```",
      "sha256  abc123",
      "size    239075328 bytes",
      "```",
      "",
      "Verify the download before opening it:",
      "",
      "```sh",
      "shasum -a 256 LocalhostAliases-2.0.0.dmg",
      "```",
    ].join("\n");

    expect(parseNotes(body)).toEqual([
      { kind: "heading", text: "Changes since v1.9.0" },
      { kind: "list", items: ["Raw TCP forwarding"] },
      { kind: "rule" },
      { kind: "code", text: "sha256  abc123\nsize    239075328 bytes" },
      { kind: "p", text: "Verify the download before opening it:" },
      { kind: "code", text: "shasum -a 256 LocalhostAliases-2.0.0.dmg" },
    ]);
  });

  test("inside a fence nothing is markup — a shell comment stays a shell comment", () => {
    const blocks = parseNotes("```sh\n# not a heading\n- not a bullet\n```");
    expect(blocks).toEqual([{ kind: "code", text: "# not a heading\n- not a bullet" }]);
  });

  test("an unterminated fence still shows its content instead of swallowing it", () => {
    expect(parseNotes("```\nmake bundle")).toEqual([{ kind: "code", text: "make bundle" }]);
  });

  test("an empty fence produces nothing rather than an empty box", () => {
    expect(parseNotes("```\n```")).toEqual([]);
  });

  test("a bullet immediately after a paragraph starts a list", () => {
    expect(parseNotes("Intro:\n- one\n- two")).toEqual([
      { kind: "p", text: "Intro:" },
      { kind: "list", items: ["one", "two"] },
    ]);
  });

  test("`*` bullets and `~~~` fences are the same thing as their twins", () => {
    expect(parseNotes("* starred")).toEqual([{ kind: "list", items: ["starred"] }]);
    expect(parseNotes("~~~\ncode\n~~~")).toEqual([{ kind: "code", text: "code" }]);
  });

  test("rules in all three markdown spellings", () => {
    for (const rule of ["---", "***", "___"]) {
      expect(parseNotes(`a\n\n${rule}\n\nb`)).toEqual([
        { kind: "p", text: "a" },
        { kind: "rule" },
        { kind: "p", text: "b" },
      ]);
    }
  });

  test("hostile text stays text: it is never markup, and React escapes it downstream", () => {
    const blocks = parseNotes("<script>alert(1)</script>\n\n- <img src=x onerror=alert(1)>");
    expect(blocks).toEqual([
      { kind: "p", text: "<script>alert(1)</script>" },
      { kind: "list", items: ["<img src=x onerror=alert(1)>"] },
    ]);
  });

  test("a long body does not blow the stack or reorder itself", () => {
    const body = Array.from({ length: 500 }, (_, i) => `- item ${i}`).join("\n");
    const blocks = parseNotes(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("list");
  });
});
