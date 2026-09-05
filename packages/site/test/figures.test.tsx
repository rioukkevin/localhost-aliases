/**
 * The homepage graphics are server-rendered markup plus one stylesheet. The one
 * that reacts to scrolling (FlowSchema) only moves emphasis: every word it will
 * ever show is in the markup at step 0. That is a testable claim, so these tests
 * render the figures the way the build does and check the still picture, the
 * motion contract and the honesty rules that would otherwise rot silently.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { FigureFrame } from "../components/landing/FigureFrame.tsx";
import { FlowSchema } from "../components/landing/FlowSchema.tsx";
import { HeroSwap } from "../components/landing/HeroSwap.tsx";
import { TrustBlock } from "../components/landing/TrustBlock.tsx";
import { ValueTiles } from "../components/landing/ValueTiles.tsx";

const FIGURES = {
  hero: renderToStaticMarkup(<HeroSwap />),
  flow: renderToStaticMarkup(<FlowSchema />),
  tiles: renderToStaticMarkup(<ValueTiles />),
  trust: renderToStaticMarkup(<TrustBlock />),
};

/** The markup without the motion sheet, which is CSS rather than a drawing. */
function markup(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/g, " ");
}

/** Markup with the tags stripped — what a reader actually gets off the page. */
function text(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

const MOTION_CSS = renderToStaticMarkup(
  <FigureFrame label="probe" caption="probe">
    <span />
  </FigureFrame>,
).match(/<style[^>]*>([\s\S]*?)<\/style>/)![1]!;

const SOURCES = [
  "FigureFrame.tsx",
  "FigureMotion.tsx",
  "FlowSchema.tsx",
  "HeroSwap.tsx",
  "TrustBlock.tsx",
  "ValueTiles.tsx",
].map((file) => ({
  file,
  body: readFileSync(join(import.meta.dir, "..", "components", "landing", file), "utf8"),
}));

describe("the figures render a complete still picture on the server", () => {
  test("the hero states both sides of the swap", () => {
    const body = text(FIGURES.hero);
    expect(body).toContain("http://localhost:");
    expect(body).toContain("3000");
    expect(body).toContain("myapp");
  });

  test("only the first port is read out, so the cycle is not four numbers in a row", () => {
    // Three of the four are decoration for a screen reader; the first is the sentence.
    expect(FIGURES.hero.match(/aria-hidden="true"/g)).toHaveLength(4);
  });

  test("the flow schema names every hop end to end, at step 0", () => {
    // Nothing here is revealed by scrolling: this is the markup a reader gets
    // with JavaScript off, and it has to be the whole chain.
    const body = text(FIGURES.flow);
    expect(body).toContain("myapp");
    expect(body).toContain("/etc/hosts");
    expect(body).toContain("127.0.0.2");
    expect(body).toContain("127.0.0.2:80");
    expect(body).toContain("raw TCP");
    expect(body).toContain("127.0.0.1:3000");
  });

  test("the flow schema numbers its steps, so the order survives without motion", () => {
    const body = text(FIGURES.flow);
    for (const step of ["1 ·", "2 ·", "3 ·", "4 ·", "5 ·"]) {
      expect(body).toContain(step);
    }
  });

  test("the tiles make all three arguments in text, not only in the drawing", () => {
    const body = text(FIGURES.tiles);
    expect(body).toContain("localhost:3000");
    expect(body).toContain("shop");
    expect(body).toContain("session");
    expect(body).toContain("https://myapp.test");
    expect(body).toContain("http://myapp.test");
  });

  test("the trust block uses the markers the app really writes", () => {
    const body = text(FIGURES.trust);
    // Straight out of packages/core/src/types.ts.
    expect(body).toContain("# >>> localhost-aliases >>>");
    expect(body).toContain("# <<< localhost-aliases <<<");
    expect(body).toContain("ifconfig lo0 alias 127.0.0.2");
    expect(body).toContain("127.0.0.1");
  });

  test("the tradeoff is stated on the page, not only linked", () => {
    const body = text(FIGURES.trust);
    expect(body).toContain("anything running as you can ask root");
    expect(body).toContain("nothing named in that file is ever executed");
    expect(body).toContain("Quit the app and nothing runs as root");
    // The href lives in an attribute, so it is checked against the markup.
    expect(FIGURES.trust).toContain("/faq#what-runs-as-root");
  });

  test("every figure that draws carries a caption, so the drawing is never the only copy", () => {
    for (const html of [FIGURES.flow]) {
      expect(html).toContain("<figcaption");
      const caption = html.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/)![1]!;
      expect(text(caption).trim().length).toBeGreaterThan(120);
    }
  });

  test("no figure ships a script or an inline handler", () => {
    for (const html of Object.values(FIGURES)) {
      expect(html).not.toContain("<script");
      expect(html).not.toMatch(/\son(click|load|mouse[a-z]+)=/);
    }
  });
});

describe("motion", () => {
  test("every animation class used in the markup is defined once, in one sheet", () => {
    const used = new Set<string>();
    for (const html of Object.values(FIGURES)) {
      for (const match of markup(html).matchAll(/la-[a-z]+/g)) used.add(match[0]);
    }
    // The classes actually applied, minus the sheet's own href.
    used.delete("la-figure");
    expect([...used].sort()).toEqual(["la-bar", "la-port", "la-probe", "la-reveal"]);

    for (const name of used) {
      expect(MOTION_CSS).toContain(`@keyframes ${name}`);
    }
  });

  test("the packet only exists while a wire is lit, and its keyframes ship anyway", () => {
    // At step 0 nothing downstream is lit, so no .la-drop is in the markup — the
    // sheet still has to define it for the moment scrolling lights one.
    expect(markup(FIGURES.flow)).not.toContain("la-drop");
    expect(MOTION_CSS).toContain("@keyframes la-drop");
  });

  test("reduced motion stops every one of them", () => {
    const reduced = MOTION_CSS.slice(MOTION_CSS.indexOf("prefers-reduced-motion"));
    expect(reduced.length).toBeGreaterThan(0);
    for (const name of ["la-probe", "la-reveal", "la-bar", "la-port"]) {
      expect(reduced).toContain(`.${name}`);
    }
    expect(reduced).toContain("animation: none !important");
    // The packet's only content is its movement, so it is removed rather than parked.
    expect(reduced).toContain("display: none !important");
  });

  test("the packet is invisible at rest, so a frozen frame is just the wire", () => {
    const rule = MOTION_CSS.slice(MOTION_CSS.indexOf(".la-drop {"));
    expect(rule).toContain("opacity: 0;");
  });

  test("the cycling port rests on one value rather than four stacked", () => {
    const rule = MOTION_CSS.slice(MOTION_CSS.indexOf(".la-port {"));
    expect(rule).toContain("opacity: 0;");
    expect(MOTION_CSS).toContain(".la-port:first-child {");
  });

  test("the sheet is hoisted and de-duplicated rather than repeated per figure", () => {
    const both = renderToStaticMarkup(
      <>
        <FlowSchema />
        <TrustBlock />
      </>,
    );
    // Two figures, one sheet: React de-duplicates a <style href> with a precedence.
    expect(both.match(/<style/g)).toHaveLength(1);
    expect(both.match(/href="la-figure-motion"/g)).toHaveLength(1);
    for (const match of both.matchAll(/<style([^>]*)>/g)) {
      expect(match[1]).toContain('precedence="medium"');
    }
  });
});

describe("the design rules a figure could quietly break", () => {
  test("no literal colour anywhere — tokens only", () => {
    for (const { file, body } of SOURCES) {
      expect({ file, hex: body.match(/#[0-9a-fA-F]{3,8}\b/g) }).toEqual({ file, hex: null });
      expect({ file, rgb: body.match(/\brgba?\(/g) }).toEqual({ file, rgb: null });
    }
  });

  test("no rounded cards and no shadows", () => {
    for (const { file, body } of SOURCES) {
      expect({ file, rounded: body.match(/rounded-(?!full\b)(?!\[2px\])[a-z[]/g) }).toEqual({
        file,
        rounded: null,
      });
      expect({ file, shadow: body.match(/\bshadow-/g) }).toEqual({ file, shadow: null });
    }
  });

  test("no example teaches a suffix the app refuses", () => {
    for (const html of Object.values(FIGURES)) {
      // .local, the HSTS-preloaded TLDs and .localhost are all rejected by validation.
      expect(text(html)).not.toMatch(/\b[a-z0-9-]+\.(local|dev|app|page|new|zip|mov|localhost)\b/);
    }
  });
});
