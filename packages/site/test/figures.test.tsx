/**
 * The homepage figures are server-rendered markup plus a stylesheet — no client
 * component, no effect, no measurement. That is a testable claim, so these tests
 * render them the way the build does and check the still picture, the motion
 * contract and the honesty rules that would otherwise rot silently.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { FigureFrame } from "../components/landing/FigureFrame.tsx";
import { MachineFigure } from "../components/landing/MachineFigure.tsx";
import { MechanismFigure } from "../components/landing/MechanismFigure.tsx";
import { ProblemFigure } from "../components/landing/ProblemFigure.tsx";

const FIGURES = {
  problem: renderToStaticMarkup(<ProblemFigure />),
  mechanism: renderToStaticMarkup(<MechanismFigure />),
  machine: renderToStaticMarkup(<MachineFigure />),
};

/** Markup with the tags stripped — what a reader actually gets off the page. */
function text(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/\s+/g, " ");
}

const MOTION_CSS = renderToStaticMarkup(
  <FigureFrame label="probe" caption="probe">
    <span />
  </FigureFrame>,
).match(/<style[^>]*>([\s\S]*?)<\/style>/)![1];

const SOURCES = ["FigureFrame.tsx", "FigureMotion.tsx", "MachineFigure.tsx", "MechanismFigure.tsx", "ProblemFigure.tsx"].map(
  (file) => ({
    file,
    body: readFileSync(join(import.meta.dir, "..", "components", "landing", file), "utf8"),
  }),
);

describe("the figures render a complete still picture on the server", () => {
  test("the problem figure states both tab bars, ports and names alike", () => {
    const body = text(FIGURES.problem);
    for (const port of ["localhost:3000", "localhost:5173", "localhost:8080", "localhost:4321"]) {
      expect(body).toContain(port);
    }
    for (const name of ["shop", "api", "docs", "admin", "blog"]) {
      expect(body).toContain(name);
    }
  });

  test("the mechanism figure names both hops end to end", () => {
    const body = text(FIGURES.mechanism);
    // name -> address, then :80 -> the dev server's port.
    expect(body).toContain("myapp");
    expect(body).toContain("/etc/hosts");
    expect(body).toContain("127.0.0.2");
    expect(body).toContain("127.0.0.2:80");
    expect(body).toContain("raw TCP");
    expect(body).toContain("127.0.0.1:3000");
  });

  test("the machine figure uses the markers the app really writes", () => {
    const body = text(FIGURES.machine);
    // Straight out of packages/core/src/types.ts.
    expect(body).toContain("# >>> localhost-aliases >>>");
    expect(body).toContain("# <<< localhost-aliases <<<");
    expect(body).toContain("ifconfig lo0 alias 127.0.0.2");
    expect(body).toContain("127.0.0.1");
  });

  test("every figure carries a caption, so the drawing is never the only copy", () => {
    for (const html of Object.values(FIGURES)) {
      expect(html).toContain("<figcaption");
      const caption = html.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/)![1]!;
      expect(text(caption).trim().length).toBeGreaterThan(120);
    }
  });

  test("nothing in a figure depends on JavaScript", () => {
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
      for (const match of html.matchAll(/la-[a-z]+/g)) used.add(match[0]);
    }
    // The classes actually applied, minus the sheet's own href.
    used.delete("la-figure");
    expect([...used].sort()).toEqual(["la-bar", "la-packet", "la-probe", "la-reveal"]);

    for (const name of used) {
      expect(MOTION_CSS).toContain(`@keyframes ${name}`);
    }
  });

  test("reduced motion stops every one of them", () => {
    const reduced = MOTION_CSS!.slice(MOTION_CSS!.indexOf("prefers-reduced-motion"));
    expect(reduced!.length).toBeGreaterThan(0);
    for (const name of ["la-probe", "la-reveal", "la-bar"]) {
      expect(reduced).toContain(`.${name}`);
    }
    expect(reduced).toContain("animation: none !important");
    // The packet's only content is its movement, so it is removed rather than parked.
    expect(reduced).toContain("display: none !important");
  });

  test("the packet is invisible at rest, so a frozen frame is just the cable", () => {
    const rule = MOTION_CSS!.slice(MOTION_CSS!.indexOf(".la-packet {"));
    expect(rule).toContain("opacity: 0;");
  });

  test("the sheet is hoisted and de-duplicated rather than repeated per figure", () => {
    const both = renderToStaticMarkup(
      <>
        <MechanismFigure />
        <MachineFigure />
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
      const source = body.replace(/^[\s\S]*?const CSS = `/, (m) => m); // the sheet is checked too
      expect({ file, hex: source.match(/#[0-9a-fA-F]{3,8}\b/g) }).toEqual({ file, hex: null });
      expect({ file, rgb: source.match(/\brgba?\(/g) }).toEqual({ file, rgb: null });
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
