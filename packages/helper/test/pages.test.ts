import { describe, expect, test } from "bun:test";
import type { Route } from "@localhost-aliases/core";
import { offlinePage, unknownHostPage, upstreamErrorPage } from "../src/pages.ts";

const route: Route = { host: "myapp.local", target: "127.0.0.1", port: 3000, aliasId: "a1" };
const ctx = { proto: "http" as const, listenerPort: 80 };

async function body(response: Response): Promise<string> {
  return await response.text();
}

describe("offline page", () => {
  test("is a 502 that names the alias and the expected port", async () => {
    const res = offlinePage(route);
    expect(res.status).toBe(502);
    const html = await body(res);
    expect(html).toContain("myapp.local");
    expect(html).toContain("127.0.0.1:3000");
    expect(html).toContain("nothing is listening on 127.0.0.1:3000");
  });

  test("auto-refreshes so it becomes the app when the dev server boots", async () => {
    const res = offlinePage(route);
    expect(await body(res)).toContain('<meta http-equiv="refresh" content="3">');
    expect(res.headers.get("retry-after")).toBe("3");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("unknown host page", () => {
  test("is a 404 listing the known aliases as links", async () => {
    const res = unknownHostPage("typo.local", [route, { ...route, host: "api.local", port: 4000 }], ctx);
    expect(res.status).toBe(404);
    const html = await body(res);
    expect(html).toContain("typo.local");
    expect(html).toContain('href="http://myapp.local"');
    expect(html).toContain('href="http://api.local"');
    expect(html).toContain(":4000");
  });

  test("includes the listener port in links when it is not the default", async () => {
    const html = await body(unknownHostPage("typo.local", [route], { proto: "http", listenerPort: 8080 }));
    expect(html).toContain('href="http://myapp.local:8080"');
  });

  test("copes with no routes and with a missing Host header", async () => {
    const html = await body(unknownHostPage(null, [], ctx));
    expect(html).toContain("(no Host header)");
    expect(html).toContain("No aliases are routed yet");
  });

  test("escapes the attacker-controlled Host header", async () => {
    const html = await body(unknownHostPage('"><script>alert(1)</script>', [], ctx));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("upstream error page", () => {
  test("is a 502 carrying the reason and does not auto-refresh", async () => {
    const res = upstreamErrorPage(route, "socket hang up");
    expect(res.status).toBe(502);
    const html = await body(res);
    expect(html).toContain("socket hang up");
    expect(html).not.toContain("http-equiv=\"refresh\"");
  });

  test("escapes the upstream-supplied detail", async () => {
    const html = await body(upstreamErrorPage(route, "<img src=x onerror=alert(1)>"));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("every page", () => {
  test("is self-contained and theme-aware", async () => {
    for (const res of [offlinePage(route), unknownHostPage("x.local", [route], ctx), upstreamErrorPage(route, "boom")]) {
      const html = await body(res);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(html).toContain("prefers-color-scheme: light");
      expect(html).toContain("#0A0A0B"); // dark canvas
      expect(html).toContain("#D6FF4B"); // lime accent
      expect(html).toContain("ui-monospace");
      // No external resource of any kind: these render on a machine with nothing running.
      expect(html).not.toMatch(/<(script|link|img)\b/);
      expect(html).not.toMatch(/(src|href)="https?:\/\/(?!myapp|api)/); // no remote assets
    }
  });
});
