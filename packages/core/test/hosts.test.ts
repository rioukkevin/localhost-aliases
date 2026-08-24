import { describe, expect, test } from "bun:test";
import { applyBlock, isValidHostname, parseBlock, renderBlock } from "../src/hosts.ts";
import { HOSTS_BEGIN, HOSTS_END } from "../src/types.ts";

const ENTRIES = [
  { ip: "127.0.0.2", hostname: "index.test" },
  { ip: "127.0.0.3", hostname: "myapp.test" },
];

const BASE = `##\n# Host Database\n##\n127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1             localhost\n`;

const BLOCK = `${HOSTS_BEGIN}\n127.0.0.2\tindex.test\n127.0.0.3\tmyapp.test\n${HOSTS_END}\n`;

describe("isValidHostname", () => {
  test.each(["index.test", "a", "my-app.test", "api.myapp.test"])("accepts %s", (h) =>
    expect(isValidHostname(h)).toBe(true),
  );
  test.each([
    "",
    "-a.test",
    "a-.test",
    "My.test",
    "a b",
    "a\tb",
    "a\nb",
    "a#b",
    "a..b",
    ".a",
    "a.",
    "a".repeat(64),
  ])("rejects %p", (h) => expect(isValidHostname(h)).toBe(false));
});

describe("renderBlock", () => {
  test("markers, tab-separated lines and a trailing newline", () => {
    expect(renderBlock(ENTRIES)).toBe(BLOCK);
  });

  test("empty entries still renders a well-formed (empty) block", () => {
    expect(renderBlock([])).toBe(`${HOSTS_BEGIN}\n${HOSTS_END}\n`);
  });

  test("honours the requested line ending", () => {
    expect(renderBlock(ENTRIES, "\r\n")).toBe(BLOCK.replace(/\n/g, "\r\n"));
  });

  test.each([
    { ip: "127.0.0.2", hostname: "bad host" },
    { ip: "127.0.0.2", hostname: "evil\n127.0.0.1\tbank.com" },
    { ip: "127.0.0.2", hostname: "" },
    { ip: "not-an-ip", hostname: "a.test" },
    { ip: "127.0.0.2 fake", hostname: "a.test" },
  ])("refuses to write %o", (entry) => {
    expect(() => renderBlock([entry])).toThrow(/Refusing to write/);
  });
});

describe("parseBlock", () => {
  test("returns the managed entries", () => {
    expect(parseBlock(BASE + BLOCK)).toEqual(ENTRIES);
  });

  test("missing block yields nothing", () => {
    expect(parseBlock(BASE)).toEqual([]);
  });

  test("empty block yields nothing", () => {
    expect(parseBlock(`${BASE}${HOSTS_BEGIN}\n${HOSTS_END}\n`)).toEqual([]);
  });

  test("tolerates spaces instead of tabs and comment lines", () => {
    const content = `${HOSTS_BEGIN}\n# a comment\n127.0.0.2    index.test\n\n${HOSTS_END}\n`;
    expect(parseBlock(content)).toEqual([{ ip: "127.0.0.2", hostname: "index.test" }]);
  });

  test("skips junk lines inside the block", () => {
    const content = `${HOSTS_BEGIN}\nnonsense\n127.0.0.2\tindex.test\n${HOSTS_END}\n`;
    expect(parseBlock(content)).toEqual([{ ip: "127.0.0.2", hostname: "index.test" }]);
  });

  test("reads the first block when there are duplicates", () => {
    const content = `${BLOCK}${BASE}${HOSTS_BEGIN}\n127.0.0.9\tother.test\n${HOSTS_END}\n`;
    expect(parseBlock(content)).toEqual(ENTRIES);
  });

  test("CRLF", () => {
    expect(parseBlock((BASE + BLOCK).replace(/\n/g, "\r\n"))).toEqual(ENTRIES);
  });

  test("round-trips renderBlock", () => {
    expect(parseBlock(renderBlock(ENTRIES))).toEqual(ENTRIES);
  });
});

describe("applyBlock", () => {
  const cases: Array<{ name: string; input: string; entries: typeof ENTRIES; expected: string }> = [
    { name: "missing block appends it", input: BASE, entries: ENTRIES, expected: BASE + BLOCK },
    {
      name: "no trailing newline gets one first",
      input: BASE.trimEnd(),
      entries: ENTRIES,
      expected: BASE + BLOCK,
    },
    { name: "empty file", input: "", entries: ENTRIES, expected: BLOCK },
    {
      name: "existing block is replaced in place",
      input: `${BASE}${BLOCK}# tail\n`,
      entries: [{ ip: "127.0.0.2", hostname: "index.test" }],
      expected: `${BASE}${HOSTS_BEGIN}\n127.0.0.2\tindex.test\n${HOSTS_END}\n# tail\n`,
    },
    {
      name: "duplicate blocks collapse into one",
      input: `${BASE}${BLOCK}# middle\n${BLOCK}`,
      entries: ENTRIES,
      expected: `${BASE}${BLOCK}# middle\n`,
    },
    {
      name: "unterminated block is replaced up to EOF",
      input: `${BASE}${HOSTS_BEGIN}\n127.0.0.2\thalf.test\n`,
      entries: ENTRIES,
      expected: BASE + BLOCK,
    },
    { name: "empty entries removes the block", input: `${BASE}${BLOCK}`, entries: [], expected: BASE },
    {
      name: "empty entries preserves content after the block",
      input: `${BASE}${BLOCK}# tail\n`,
      entries: [],
      expected: `${BASE}# tail\n`,
    },
    { name: "empty entries with no block is a no-op", input: BASE, entries: [], expected: BASE },
  ];

  for (const c of cases) {
    test(c.name, () => expect(applyBlock(c.input, c.entries)).toBe(c.expected));
  }

  test("is idempotent", () => {
    const once = applyBlock(BASE, ENTRIES);
    expect(applyBlock(once, ENTRIES)).toBe(once);
    expect(applyBlock(applyBlock(once, ENTRIES), ENTRIES)).toBe(once);
  });

  test("removal is idempotent", () => {
    const removed = applyBlock(BASE + BLOCK, []);
    expect(applyBlock(removed, [])).toBe(removed);
  });

  test("apply then remove restores the original bytes", () => {
    expect(applyBlock(applyBlock(BASE, ENTRIES), [])).toBe(BASE);
  });

  test("preserves everything outside the markers byte for byte", () => {
    const weird = `# leading\r\n\n\n127.0.0.1   local host stuff\t\n\n`;
    const applied = applyBlock(weird, ENTRIES);
    expect(applyBlock(applied, [])).toBe(weird);
  });

  test("CRLF files keep CRLF in the managed block", () => {
    const crlf = BASE.replace(/\n/g, "\r\n");
    const applied = applyBlock(crlf, ENTRIES);
    expect(applied).toBe(crlf + BLOCK.replace(/\n/g, "\r\n"));
    expect(applyBlock(applied, ENTRIES)).toBe(applied);
    expect(applyBlock(applied, [])).toBe(crlf);
  });

  test("refuses invalid entries before touching the file", () => {
    expect(() => applyBlock(BASE, [{ ip: "127.0.0.2", hostname: "a\nb" }])).toThrow(/Refusing to write/);
  });

  test("never rewrites the real hosts entries", () => {
    expect(applyBlock(BASE, ENTRIES).startsWith(BASE)).toBe(true);
  });
});
