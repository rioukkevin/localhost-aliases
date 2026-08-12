import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOSTS_BEGIN, HOSTS_END } from "../src/types.ts";
import {
  applyBlock,
  flushDns,
  isValidHostname,
  parseBlock,
  readHosts,
  renderBlock,
  writeHosts,
} from "../src/hosts.ts";

/** Shorthand: the exact block text for a set of hostnames. */
const block = (...hosts: string[]) => renderBlock(hosts);

const B = block("a.local");

// ---------------------------------------------------------------------------
describe("renderBlock", () => {
  test("wraps the entries in the markers and ends with a newline", () => {
    const out = block("myapp.local");
    expect(out.startsWith(`${HOSTS_BEGIN}\n`)).toBe(true);
    expect(out.endsWith(`${HOSTS_END}\n`)).toBe(true);
  });

  test("emits an IPv4 and an IPv6 line per hostname, tab separated", () => {
    const lines = block("myapp.local", "api.local").trimEnd().split("\n");
    expect(lines).toEqual([
      HOSTS_BEGIN,
      "# Managed by localhost-aliases. Edit aliases in the dashboard, not here.",
      "127.0.0.1\tmyapp.local",
      "::1\tmyapp.local",
      "127.0.0.1\tapi.local",
      "::1\tapi.local",
      HOSTS_END,
    ]);
  });

  test("dedupes while keeping the input order", () => {
    expect(parseBlock(block("b.local", "a.local", "b.local"))).toEqual(["b.local", "a.local"]);
  });

  test("an empty list still renders the markers", () => {
    expect(block()).toBe(`${HOSTS_BEGIN}\n# Managed by localhost-aliases. Edit aliases in the dashboard, not here.\n${HOSTS_END}\n`);
  });

  test("refuses to emit hostnames that would inject lines", () => {
    const out = block("ok.local", "evil.local\n127.0.0.1\tbank.com", "has space.local", "no#hash");
    expect(parseBlock(out)).toEqual(["ok.local"]);
    expect(out.split("\n").filter((l) => l.startsWith("127.0.0.1"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("parseBlock", () => {
  const cases: Array<{ name: string; content: string; expected: string[] }> = [
    { name: "empty string", content: "", expected: [] },
    { name: "no block present", content: "127.0.0.1\tlocalhost\n", expected: [] },
    { name: "a rendered block round-trips", content: block("a.local", "b.local"), expected: ["a.local", "b.local"] },
    {
      name: "several names on one line",
      content: `${HOSTS_BEGIN}\n127.0.0.1 a.local b.local\n${HOSTS_END}\n`,
      expected: ["a.local", "b.local"],
    },
    {
      name: "user comments and blank lines inside the block are ignored",
      content: `${HOSTS_BEGIN}\n# a note\n\n127.0.0.1\ta.local\n${HOSTS_END}\n`,
      expected: ["a.local"],
    },
    {
      name: "duplicate blocks are merged and deduped",
      content: `${block("x.local")}mid\n${block("y.local", "x.local")}`,
      expected: ["x.local", "y.local"],
    },
    {
      name: "unterminated block is read to EOF",
      content: `${HOSTS_BEGIN}\n127.0.0.1\ta.local\n127.0.0.1\tb.local\n`,
      expected: ["a.local", "b.local"],
    },
    {
      name: "CRLF content",
      content: `top\r\n${HOSTS_BEGIN}\r\n127.0.0.1\ta.local\r\n${HOSTS_END}\r\n`,
      expected: ["a.local"],
    },
    {
      name: "markers with trailing whitespace still match",
      content: `${HOSTS_BEGIN}   \n127.0.0.1\ta.local\n${HOSTS_END}\t\n`,
      expected: ["a.local"],
    },
    {
      name: "a stray END marker without a BEGIN is not a block",
      content: `${HOSTS_END}\n127.0.0.1\ta.local\n`,
      expected: [],
    },
  ];

  for (const c of cases) {
    test(c.name, () => expect(parseBlock(c.content)).toEqual(c.expected));
  }
});

// ---------------------------------------------------------------------------
describe("applyBlock", () => {
  const cases: Array<{ name: string; content: string; hosts: string[]; expected: string }> = [
    { name: "empty file gets the block", content: "", hosts: ["a.local"], expected: B },
    {
      name: "appends after content ending with a newline",
      content: "127.0.0.1\tlocalhost\n",
      hosts: ["a.local"],
      expected: `127.0.0.1\tlocalhost\n\n${B}`,
    },
    {
      name: "appends after content with no trailing newline",
      content: "127.0.0.1\tlocalhost",
      hosts: ["a.local"],
      expected: `127.0.0.1\tlocalhost\n\n${B}`,
    },
    {
      name: "replaces an existing block in place",
      content: `top\n\n${block("old.local")}\nbottom\n`,
      hosts: ["a.local"],
      expected: `top\n\n${B}\nbottom\n`,
    },
    {
      name: "block at the very start of the file",
      content: `${block("old.local")}\nrest\n`,
      hosts: ["a.local"],
      expected: `${B}\nrest\n`,
    },
    {
      name: "block at EOF with no trailing newline",
      content: `A\n${block("old.local").replace(/\n$/, "")}`,
      hosts: ["a.local"],
      expected: `A\n\n${B}`,
    },
    {
      name: "unterminated block is claimed to EOF",
      content: `A\n${HOSTS_BEGIN}\n127.0.0.1\tstale.local\ntrailing\n`,
      hosts: ["a.local"],
      expected: `A\n\n${B}`,
    },
    {
      name: "duplicate blocks collapse into one at the first position",
      content: `A\n${block("x.local")}B\n${block("y.local")}C\n`,
      hosts: ["a.local"],
      expected: `A\n\n${B}\nB\nC\n`,
    },
    {
      name: "empty hostnames removes the block and its blank lines",
      content: `A\n\n${block("a.local")}\nB\n`,
      hosts: [],
      expected: "A\nB\n",
    },
    {
      name: "empty hostnames removes a block that is the whole file",
      content: block("a.local"),
      hosts: [],
      expected: "",
    },
    {
      name: "empty hostnames on a file without a block is the identity",
      content: "A\n\nB",
      hosts: [],
      expected: "A\n\nB",
    },
    {
      name: "empty hostnames removes duplicate blocks but keeps what is between them",
      content: `A\n${block("x.local")}B\n${block("y.local")}C\n`,
      hosts: [],
      expected: "A\nB\nC\n",
    },
    {
      name: "preserves CRLF outside the block",
      content: "A\r\nB\r\n",
      hosts: ["a.local"],
      expected: `A\r\nB\r\n\n${B}`,
    },
    {
      name: "preserves trailing whitespace on surrounding lines",
      content: "A   \t\nB\n",
      hosts: ["a.local"],
      expected: `A   \t\nB\n\n${B}`,
    },
    {
      name: "extra blank lines around an existing block are left alone",
      content: `A\n\n\n${block("old.local")}\n\nB\n`,
      hosts: ["a.local"],
      expected: `A\n\n\n${B}\n\nB\n`,
    },
    {
      name: "a list of only invalid hostnames still writes an empty block",
      content: "",
      hosts: ["BAD NAME"],
      expected: block(),
    },
  ];

  for (const c of cases) {
    test(c.name, () => expect(applyBlock(c.content, c.hosts)).toBe(c.expected));
  }
});

// ---------------------------------------------------------------------------
describe("applyBlock properties", () => {
  const fixtures: string[] = [
    "",
    "\n",
    "A",
    "A\n",
    "A\n\n",
    "127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1\tlocalhost\n",
    "A\r\nB\r\n",
    "A   \t\nB\n",
    block("old.local"),
    `A\n${block("old.local")}B\n`,
    `A\n\n${block("old.local")}\nB\n`,
    `A\n${block("old.local").replace(/\n$/, "")}`,
    `A\n${block("x.local")}B\n${block("y.local")}C\n`,
    `A\n${HOSTS_BEGIN}\n127.0.0.1\tstale.local\n`,
    `${block("x.local")}\n\n${block("y.local")}`,
  ];

  const hostSets: string[][] = [[], ["a.local"], ["a.local", "b.local"], ["only.local"]];

  for (const [fi, content] of fixtures.entries()) {
    for (const [hi, hosts] of hostSets.entries()) {
      test(`idempotent: fixture ${fi} x hosts ${hi}`, () => {
        const once = applyBlock(content, hosts);
        expect(applyBlock(once, hosts)).toBe(once);
      });

      test(`round-trips through parseBlock: fixture ${fi} x hosts ${hi}`, () => {
        expect(parseBlock(applyBlock(content, hosts))).toEqual(hosts);
      });
    }

    test(`content outside the markers does not depend on the hostnames: fixture ${fi}`, () => {
      // Stripping the block from two different applications must give the same text.
      const a = applyBlock(applyBlock(content, ["a.local"]), []);
      const b = applyBlock(applyBlock(content, ["x.local", "y.local"]), []);
      expect(a).toBe(b);
    });
  }

  test("a real hosts file is preserved byte-for-byte outside the markers", () => {
    const original = [
      "##",
      "# Host Database",
      "#",
      "127.0.0.1\tlocalhost",
      "255.255.255.255\tbroadcasthost",
      "::1             localhost",
      "",
    ].join("\n");
    const applied = applyBlock(original, ["a.local"]);
    expect(applied.startsWith(original)).toBe(true);
    expect(applyBlock(applied, [])).toBe(original);
  });

  test("never emits a line for a hostname the helper would reject", () => {
    const out = applyBlock("A\n", ["good.local", "localhost", "UPPER.local", "bad_name.local"]);
    expect(parseBlock(out)).toEqual(["good.local"]);
  });
});

// ---------------------------------------------------------------------------
describe("isValidHostname", () => {
  const valid = [
    "myapp.local",
    "a",
    "a1",
    "a-b.local",
    "api.myapp.local",
    "x1.test",
    `${"a".repeat(63)}.local`,
  ];
  const invalid = [
    "",
    " ",
    "localhost",
    "local",
    "broadcasthost",
    "LOCALHOST",
    "MyApp.local",
    "myapp.LOCAL",
    "my app.local",
    "my\tapp.local",
    "evil.local\n127.0.0.1\tbank.com",
    "app#comment",
    "#comment",
    "-bad.local",
    "bad-.local",
    "bad..local",
    ".local",
    "local.",
    "myapp.local.",
    "under_score.local",
    "app!.local",
    `${"a".repeat(64)}.local`,
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
  ];

  for (const host of valid) {
    test(`accepts ${JSON.stringify(host)}`, () => expect(isValidHostname(host)).toBe(true));
  }
  for (const host of invalid) {
    test(`rejects ${JSON.stringify(host)}`, () => expect(isValidHostname(host)).toBe(false));
  }

  test("rejects a hostname over 253 characters", () => {
    const labels = Array.from({ length: 40 }, (_, i) => `l${i}abcd`); // 40 * 7 - 1 = 279 chars
    const host = labels.join(".");
    expect(host.length).toBeGreaterThan(253);
    expect(isValidHostname(host)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("readHosts / writeHosts", () => {
  let dir = "";
  let target = "";
  const previous = process.env.LA_HOSTS_PATH;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "la-hosts-"));
    target = join(dir, "hosts");
    process.env.LA_HOSTS_PATH = target;
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.LA_HOSTS_PATH;
    else process.env.LA_HOSTS_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  });

  test("the suite is pointed at a temp file, never the real /etc/hosts", () => {
    expect(process.env.LA_HOSTS_PATH).toBe(target);
    expect(target.startsWith(dir)).toBe(true);
    expect(target).not.toBe("/etc/hosts");
  });

  test("reading a missing file yields an empty string", async () => {
    expect(await readHosts()).toBe("");
  });

  test("writes then reads back verbatim", async () => {
    const content = "A\r\n  trailing   \n\n";
    await writeHosts(content);
    expect(await readHosts()).toBe(content);
  });

  test("writes mode 0644", async () => {
    await writeHosts("x\n");
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  test("overwrites without leaving temp files behind", async () => {
    await writeHosts("first\n");
    await writeHosts("second\n");
    expect(await readHosts()).toBe("second\n");
    expect(await readdir(dir)).toEqual(["hosts"]);
  });

  test("survives a full read -> apply -> write cycle", async () => {
    await writeHosts("127.0.0.1\tlocalhost\n");
    const applied = applyBlock(await readHosts(), ["a.local"]);
    await writeHosts(applied);
    expect(parseBlock(await readHosts())).toEqual(["a.local"]);

    const removed = applyBlock(await readHosts(), []);
    await writeHosts(removed);
    expect(await readHosts()).toBe("127.0.0.1\tlocalhost\n");
  });
});

// ---------------------------------------------------------------------------
describe("flushDns", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  test.skipIf(isRoot)("returns false instead of throwing when not privileged", async () => {
    expect(await flushDns()).toBe(false);
  });
});
