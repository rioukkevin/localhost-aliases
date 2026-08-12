import { describe, expect, test } from "bun:test";
import type { Route } from "@localhost-aliases/core";
import { RouteTable, hostKey, validateApplyRequest } from "../src/routes.ts";

function route(host: string, port = 3000, target = "127.0.0.1"): Route {
  return { host, target, port, aliasId: `id-${host}` };
}

describe("hostKey", () => {
  test.each([
    ["myapp.local", "myapp.local"],
    ["MyApp.Local", "myapp.local"],
    ["myapp.local:8080", "myapp.local"],
    ["  myapp.local:80  ", "myapp.local"],
    ["myapp.local.", "myapp.local"],
    ["[::1]:8080", "::1"],
    ["[::1]", "::1"],
  ])("%s -> %s", (input, expected) => {
    expect(hostKey(input)).toBe(expected);
  });

  test.each([[null], [undefined], [""], ["   "], [":8080"], ["[::1"]])("%p -> null", (input) => {
    expect(hostKey(input as string | null | undefined)).toBeNull();
  });
});

describe("RouteTable", () => {
  test("looks up by Host header, ignoring case and port", () => {
    const table = new RouteTable();
    table.swap([route("myapp.local")]);
    expect(table.lookup("MYAPP.local:80")?.port).toBe(3000);
    expect(table.lookup("other.local")).toBeNull();
    expect(table.lookup(null)).toBeNull();
  });

  test("swap replaces the whole table", () => {
    const table = new RouteTable();
    table.swap([route("a.local"), route("b.local")]);
    expect(table.size).toBe(2);
    table.swap([route("c.local")]);
    expect(table.hosts()).toEqual(["c.local"]);
    expect(table.lookup("a.local")).toBeNull();
  });

  test("first entry wins on a duplicate host", () => {
    const table = new RouteTable();
    table.swap([route("dup.local", 1111), route("dup.local", 2222)]);
    expect(table.size).toBe(1);
    expect(table.lookup("dup.local")?.port).toBe(1111);
  });

  test("list() returns the live routes for the 404 page", () => {
    const table = new RouteTable();
    table.swap([route("a.local", 1), route("b.local", 2)]);
    expect(table.list().map((r) => r.port)).toEqual([1, 2]);
  });
});

describe("validateApplyRequest", () => {
  const base = { httpPort: 80, httpsPort: 443, routes: [] as unknown[], tls: null };

  test("accepts a well-formed request and normalises host/target case", () => {
    const result = validateApplyRequest({ ...base, routes: [{ host: "MyApp.Local", target: "127.0.0.1", port: 3000, aliasId: "x" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.routes[0]).toEqual({ host: "myapp.local", target: "127.0.0.1", port: 3000, aliasId: "x" });
  });

  test.each([
    ["a hostname with an injected newline", "evil.local\n127.0.0.1 apple.com"],
    ["a hostname with whitespace", "evil local"],
    ["a hostname with a comment marker", "evil#.local"],
    ["a reserved name", "localhost"],
    ["an uppercase-only-invalid character", "evil_.local"],
    ["an empty hostname", ""],
    ["a leading hyphen", "-evil.local"],
  ])("rejects %s", (_label, host) => {
    const result = validateApplyRequest({ ...base, routes: [{ host, target: "127.0.0.1", port: 3000, aliasId: "x" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("routes[0].host");
  });

  test("rejects a non-loopback target so the daemon can never become an open proxy", () => {
    for (const target of ["10.0.0.5", "example.com", "0.0.0.0", ""]) {
      const result = validateApplyRequest({ ...base, routes: [{ host: "ok.local", target, port: 3000, aliasId: "x" }] });
      expect(result.ok).toBe(false);
    }
    for (const target of ["127.0.0.1", "::1", "localhost"]) {
      expect(validateApplyRequest({ ...base, routes: [{ host: "ok.local", target, port: 3000, aliasId: "x" }] }).ok).toBe(true);
    }
  });

  test("rejects bad ports everywhere", () => {
    expect(validateApplyRequest({ ...base, httpPort: 0 }).ok).toBe(false);
    expect(validateApplyRequest({ ...base, httpsPort: 70000 }).ok).toBe(false);
    expect(validateApplyRequest({ ...base, httpPort: "80" }).ok).toBe(false);
    expect(validateApplyRequest({ ...base, routes: [{ host: "ok.local", target: "127.0.0.1", port: 3.5, aliasId: "x" }] }).ok).toBe(false);
  });

  test("rejects one bad entry among good ones — the whole request or nothing", () => {
    const result = validateApplyRequest({
      ...base,
      routes: [
        { host: "good.local", target: "127.0.0.1", port: 3000, aliasId: "a" },
        { host: "bad local", target: "127.0.0.1", port: 3000, aliasId: "b" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("routes[1]");
  });

  test("validates the shape of tls material", () => {
    expect(validateApplyRequest({ ...base, tls: { cert: "PEM", key: "PEM" } }).ok).toBe(true);
    expect(validateApplyRequest({ ...base, tls: { cert: "PEM" } }).ok).toBe(false);
    expect(validateApplyRequest({ ...base, tls: { cert: "", key: "PEM" } }).ok).toBe(false);
    expect(validateApplyRequest({ ...base, tls: "yes" }).ok).toBe(false);
  });

  test("rejects junk bodies", () => {
    expect(validateApplyRequest(null).ok).toBe(false);
    expect(validateApplyRequest([]).ok).toBe(false);
    expect(validateApplyRequest({ ...base, routes: "nope" }).ok).toBe(false);
    expect(validateApplyRequest({ ...base, routes: ["nope"] }).ok).toBe(false);
  });
});
