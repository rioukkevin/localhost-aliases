/**
 * The FAQ is typed data, so the things that rot silently are checkable: a duplicate anchor, a
 * link to a page that does not exist, a question the contract asked for that quietly vanished.
 *
 * The last block of tests is the unusual one. An FAQ's failure mode is not a broken link, it
 * is a comforting sentence that is not true, so the claims that would be tempting to soften —
 * the standing root process, the missing signature, http:// only, arm64 only — are asserted
 * here. If someone edits them out, this file fails, and that is the point.
 */
import { describe, expect, test } from "bun:test";
import { DOC_PAGES } from "../lib/docs/pages.ts";
import { FAQ_ITEMS } from "../lib/faq.ts";
import { pageLinks, tokenizeInline } from "../lib/docs/schema.ts";
import { MINIMUM_MACOS } from "../lib/product.ts";

/** The FAQ reuses the docs' block model, so it can reuse the docs' link extractor. */
function faqLinks(): string[] {
  return FAQ_ITEMS.flatMap((item) => pageLinks({ slug: item.id, title: item.question, lede: "", sections: [{ id: item.id, title: item.question, blocks: item.blocks }] }));
}

/** Every word of prose in an answer, for claim checking. */
function answerText(id: string): string {
  const item = FAQ_ITEMS.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`no FAQ item ${id}`);

  const parts: string[] = [];
  for (const block of item.blocks) {
    switch (block.kind) {
      case "p":
        parts.push(block.text);
        break;
      case "list":
      case "steps":
        parts.push(...block.items);
        break;
      case "note":
        parts.push(block.title, block.text);
        break;
      case "code":
      case "figure":
        parts.push(block.value);
        break;
      case "table":
        parts.push(...block.head, ...block.rows.flat());
        break;
    }
  }
  return parts.join("\n");
}

const ALL_TEXT = FAQ_ITEMS.map((item) => `${item.question}\n${answerText(item.id)}`).join("\n");

describe("structure", () => {
  test("every question the contract lists has an answer", () => {
    expect(FAQ_ITEMS.map((item) => item.id)).toEqual([
      "why-not-edit-hosts",
      "what-runs-as-root",
      "http-only",
      "test-not-local",
      "hmr-websockets",
      "reboot",
      "uninstall",
      "phone-home",
      "signing",
      "apple-silicon",
    ]);
  });

  test("anchors are unique and URL-safe", () => {
    const ids = FAQ_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  test("no question is unanswered, and no answer is a sentence long", () => {
    for (const item of FAQ_ITEMS) {
      expect(item.question.length).toBeGreaterThan(0);
      expect(item.blocks.length).toBeGreaterThan(0);
      expect(answerText(item.id).length).toBeGreaterThan(160);
    }
  });

  test("every table row matches its header width", () => {
    for (const item of FAQ_ITEMS) {
      for (const block of item.blocks) {
        if (block.kind !== "table") continue;
        for (const row of block.rows) expect(row).toHaveLength(block.head.length);
      }
    }
  });

  test("internal links point at routes that exist", () => {
    const routes = new Set([
      "/",
      "/download",
      "/faq",
      "/docs",
      "/changelog",
      ...DOC_PAGES.map((page) => `/docs/${page.slug}`),
    ]);

    for (const href of faqLinks()) {
      if (!href.startsWith("/")) continue;
      const [path, hash] = href.split("#");
      expect(routes.has(path ?? "")).toBe(true);
      // A link into the docs must land on a section that is really there.
      if (hash !== undefined && path !== undefined && path.startsWith("/docs/")) {
        const page = DOC_PAGES.find((candidate) => `/docs/${candidate.slug}` === path);
        expect(page?.sections.map((section) => section.id)).toContain(hash);
      }
    }
  });

  test("external links are https and nothing else", () => {
    for (const href of faqLinks()) {
      if (href.startsWith("/") || href.startsWith("#")) continue;
      expect(href).toMatch(/^https:\/\//);
    }
  });

  test("inline markup parses — an unclosed backtick would render as a stray character", () => {
    for (const item of FAQ_ITEMS) {
      const text = answerText(item.id);
      expect(tokenizeInline(text).length).toBeGreaterThan(0);
      expect((text.match(/`/g) ?? []).length % 2).toBe(0);
    }
  });
});

describe("claims that must stay true", () => {
  test("the root process is described as standing, with its real timings", () => {
    const text = answerText("what-runs-as-root");
    expect(text).toContain("one macOS admin prompt");
    expect(text).toContain("5 seconds"); // LIVENESS_TOUCH_MS
    expect(text).toContain("15 seconds"); // LIVENESS_TIMEOUT_MS
    expect(text).toMatch(/nothing is installed/i);
  });

  test("the privilege-escalation tradeoff is stated, not buried", () => {
    const text = answerText("what-runs-as-root");
    expect(text).toContain("desired-state.json");
    expect(text).toMatch(/privilege escalation/i);
    expect(text).toContain("127.0.0.2");
    expect(text).toContain("127.0.0.254");
  });

  test("http:// only, with the structural reason", () => {
    const text = answerText("http-only");
    expect(text).toContain("`http://` only");
    expect(text).toMatch(/never parses|raw TCP bytes/);
    expect(text).toMatch(/terminate TLS/);
    // The dashboard exception is real and is the only https:// claim allowed.
    expect(text).toContain("https://index.test");
  });

  test("the .local answer carries the measured number, not a vibe", () => {
    const text = answerText("test-not-local");
    expect(text).toContain("5.006s");
    expect(text).toContain("0.003s");
    expect(text).toMatch(/five seconds/);
    expect(text).toContain("RFC 6762");
    expect(text).toContain("RFC 6761");
  });

  test("WebSockets work because nothing is parsed — and the caveats are not hidden", () => {
    const text = answerText("hmr-websockets");
    expect(text).toMatch(/nothing is parsed/i);
    expect(text).toContain("127.0.0.1");
    expect(text).toMatch(/allowedHosts|config\.hosts/);
  });

  test("reboot: the hosts block survives, lo0 does not", () => {
    const text = answerText("reboot");
    expect(text).toContain("/etc/hosts");
    expect(text).toContain("lo0");
    expect(text).toMatch(/one admin prompt per login/);
  });

  test("uninstall says what is left behind, and that a cancelled prompt removes nothing", () => {
    const text = answerText("uninstall");
    expect(text).toMatch(/login/);
    expect(text).toMatch(/fingerprint/);
    expect(text).toMatch(/removes nothing/);
  });

  test("no telemetry, no auto-update", () => {
    const text = answerText("phone-home");
    expect(text).toMatch(/no telemetry/i);
    expect(text).toMatch(/no auto-update/i);
  });

  test("the signing answer is the true one", () => {
    const text = answerText("signing");
    expect(text).toMatch(/No release has been published/);
    expect(text).toMatch(/nothing has been (signed|submitted)/i);
    expect(text).toMatch(/notariz/i);
    expect(text).toContain("spctl -a -vvv -t install");
    // Nowhere may the FAQ claim the current build is notarized or Developer ID signed.
    expect(ALL_TEXT).not.toMatch(/\bis notarized\b/);
    expect(ALL_TEXT).not.toMatch(/signed with a Developer ID\./);
  });

  test("Apple Silicon only, macOS 13+, no Intel build implied anywhere", () => {
    const text = answerText("apple-silicon");
    expect(text).toContain("arm64-apple-macos13.0");
    expect(text).toMatch(/no universal binary/);
    expect(text).toMatch(/no x86_64 slice for an Intel Mac/);
    expect(text).toContain(MINIMUM_MACOS);
    expect(ALL_TEXT).not.toMatch(/universal build|Intel and Apple Silicon|x86_64 build/);
  });

  test("every example hostname ends in a TLD the app accepts", () => {
    const hostnames = ALL_TEXT.match(/\b[a-z0-9-]+\.(test|local|localhost|dev|app|page|internal|lan|example)\b/g) ?? [];
    for (const hostname of hostnames) {
      const tld = hostname.split(".").pop();
      // `.local` and the refused TLDs may only appear where they are being explained.
      if (tld === "test" || tld === "internal" || tld === "lan" || tld === "example") continue;
      expect(["test-not-local", "http-only"]).toContain(
        FAQ_ITEMS.find((item) => answerText(item.id).includes(hostname))?.id ?? "",
      );
    }
  });
});
