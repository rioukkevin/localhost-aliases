/**
 * The offline page, as a pure function: the sniff that decides whether we may answer at
 * all, and the document itself.
 *
 * The sniff is the important half. Writing HTML into a Postgres or SSH connection does not
 * produce a nice error, it produces a corruption bug, so "not obviously HTTP" must mean
 * silence.
 */
import { describe, expect, test } from "bun:test";
import type { Route } from "@localhost-aliases/core/types";
import { dashboardOfflineUrl, offlinePage, offlineResponse, sniffHttpRequest } from "../src/offline.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function route(over: Partial<Route> = {}): Route {
  return { ip: "127.0.0.2", listenPort: 80, targetPort: 3000, hostname: "myapp.test", ...over };
}

describe("sniffHttpRequest", () => {
  test("every method we recognise", () => {
    for (const method of ["GET", "POST", "PUT", "HEAD", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]) {
      expect(sniffHttpRequest(bytes(`${method} / HTTP/1.1\r\n`))).toBe("http");
    }
  });

  test("a WebSocket upgrade is just a GET, so it gets the page too", () => {
    expect(sniffHttpRequest(bytes("GET /socket HTTP/1.1\r\nUpgrade: websocket\r\n"))).toBe("http");
  });

  test("the method must be followed by a space", () => {
    expect(sniffHttpRequest(bytes("GETX / HTTP/1.1"))).toBe("not-http");
    expect(sniffHttpRequest(bytes("GET/ HTTP/1.1"))).toBe("not-http");
  });

  test("lowercase is not HTTP", () => {
    // HTTP methods are case-sensitive; `get` is not a request line, it is someone's protocol.
    expect(sniffHttpRequest(bytes("get / HTTP/1.1"))).toBe("not-http");
  });

  test("real non-HTTP openers are refused", () => {
    // TLS ClientHello, SSH banner, Postgres startup length prefix, MySQL greeting.
    expect(sniffHttpRequest(new Uint8Array([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01]))).toBe("not-http");
    expect(sniffHttpRequest(bytes("SSH-2.0-OpenSSH_9.6"))).toBe("not-http");
    expect(sniffHttpRequest(new Uint8Array([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]))).toBe("not-http");
    expect(sniffHttpRequest(bytes("\u0000\u0000\u0000\nJ8.0.35"))).toBe("not-http");
  });

  test("a prefix that could still become a method is 'unknown', not a guess", () => {
    expect(sniffHttpRequest(bytes(""))).toBe("unknown");
    expect(sniffHttpRequest(bytes("G"))).toBe("unknown");
    expect(sniffHttpRequest(bytes("OPTION"))).toBe("unknown");
    // ...but a prefix that cannot is decided at once.
    expect(sniffHttpRequest(bytes("Z"))).toBe("not-http");
  });
});

describe("the page", () => {
  const page = offlinePage(route());

  test("names the alias and the port nothing is listening on", () => {
    expect(page).toContain("myapp");
    expect(page).toContain(".test");
    expect(page).toContain("3000");
    expect(page).toContain("http://myapp.test");
  });

  test("links to the dashboard's fuller page", () => {
    expect(page).toContain("http://index.test/offline?host=myapp.test");
    expect(dashboardOfflineUrl("api.myapp.internal")).toBe("http://index.internal/offline?host=api.myapp.internal");
    // No TLD to borrow: no link rather than a link that resolves nowhere.
    expect(dashboardOfflineUrl("myapp")).toBeNull();
  });

  test("is self-contained: no external request of any kind", () => {
    expect(page).not.toContain("<script");
    expect(page).not.toMatch(/https?:\/\/(?!myapp\.test|index\.test)/);
    expect(page).not.toContain("<link");
    expect(page).not.toContain("<img");
  });

  test("carries both themes and respects reduced motion", () => {
    // DESIGN.md: "Dark is the default surface; light is a full re-theme, not a tint." So
    // dark lives on bare :root and light is the prefers-color-scheme override.
    expect(page).toContain(":root{--canvas:#0a0a0b");
    expect(page).toContain("@media (prefers-color-scheme:light)");
    expect(page).toContain('content="dark light"');
    expect(page).toContain("prefers-reduced-motion:reduce");
    // DESIGN.md's tokens, not invented colours.
    expect(page).toContain("#0a0a0b");
    expect(page).toContain("#d6ff4b");
    expect(page).toContain("#f5a524");
  });

  test("auto-reloads, and does not redirect: the alias URL stays in the address bar", () => {
    expect(page).toContain('http-equiv="refresh"');
    expect(page).not.toContain("window.location");
    expect(page).not.toContain("Location:");
  });

  test("prints the command when a hint is known", () => {
    const withHint = offlinePage(route({ hint: { framework: "Next.js", command: "next dev -p 3000" } }));
    expect(withHint).toContain("Next.js");
    expect(withHint).toContain("next dev -p 3000");
  });

  test("says so plainly when no command is known, rather than guessing", () => {
    expect(page).toContain("no command known");
    expect(page).toContain("not a stack we recognise");
  });

  test("everything interpolated is escaped", () => {
    // The hint came out of a file the agent does not trust.
    const nasty = offlinePage(
      route({ hint: { framework: "<script>alert(1)</script>", command: 'x" onload="alert(2)' } }),
    );
    expect(nasty).not.toContain("<script>alert(1)");
    expect(nasty).toContain("&lt;script&gt;");
    expect(nasty).toContain("&quot; onload=&quot;");
    // The one <script we would ever accept is none.
    expect(nasty).not.toContain("<script");
  });
});

describe("the response", () => {
  const raw = new TextDecoder().decode(offlineResponse(route()));

  test("is a well-formed 503 that closes", () => {
    expect(raw.startsWith("HTTP/1.1 503 Service Unavailable\r\n")).toBe(true);
    expect(raw).toContain("Content-Type: text/html; charset=utf-8\r\n");
    expect(raw).toContain("Connection: close\r\n");
    expect(raw).toContain("Cache-Control: no-store\r\n");
    expect(raw).toContain("Retry-After: ");
  });

  test("the Content-Length is the real byte length, not the character count", () => {
    const [head, body] = raw.split("\r\n\r\n");
    const declared = Number(/Content-Length: (\d+)/.exec(head ?? "")?.[1]);
    expect(declared).toBe(new TextEncoder().encode(body ?? "").byteLength);
  });
});
