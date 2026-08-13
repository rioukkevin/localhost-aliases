import { describe, expect, test } from "bun:test";
import { ValidationError } from "@localhost-aliases/core";
import { NotFoundError, json, problem, readJson, route } from "../lib/http.ts";

function get(url = "http://127.0.0.1/api/test"): Request {
  return new Request(url);
}

describe("json", () => {
  test("is never cached: the dashboard is a live view of the machine", async () => {
    const response = json({ a: 1 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ a: 1 });
  });
});

describe("route", () => {
  test("wraps a plain value as JSON", async () => {
    const response = await route(async () => ({ hello: "world" }))(get());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: "world" });
  });

  test("passes a Response straight through", async () => {
    const response = await route(async () => problem(501, "nope"))(get());
    expect(response.status).toBe(501);
  });

  test("a ValidationError becomes a 400 with its issues", async () => {
    const handler = route(async () => {
      throw new ValidationError([{ field: "port", message: "Port must be between 1 and 65535." }]);
    });
    const response = await handler(get());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "port: Port must be between 1 and 65535.",
      issues: [{ field: "port", message: "Port must be between 1 and 65535." }],
    });
  });

  test("a NotFoundError becomes a 404", async () => {
    const response = await route(async () => {
      throw new NotFoundError('No alias with id "x".');
    })(get());

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('No alias with id "x".');
  });

  test("anything else becomes a generic 500 that leaks no internals", async () => {
    const original = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const response = await route(async () => {
        throw new Error("ENOENT: /Users/someone/secret.key");
      })(get());

      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("secret.key");
      expect(logged).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  test("extra route arguments (Next's params) are passed on", async () => {
    const handler = route(async (_request: Request, context: { params: Promise<{ id: string }> }) => ({
      id: (await context.params).id,
    }));
    const response = await handler(get(), { params: Promise.resolve({ id: "abc" }) });
    expect(await response.json()).toEqual({ id: "abc" });
  });
});

describe("readJson", () => {
  test("an empty body is an empty object", async () => {
    expect(await readJson(new Request("http://x/", { method: "POST" }))).toEqual({});
  });

  test("malformed JSON is a 400, not a 500", async () => {
    const handler = route(async (request: Request) => readJson(request));
    const response = await handler(new Request("http://x/", { method: "POST", body: "{not json" }));
    expect(response.status).toBe(400);
    expect((await response.json()).issues[0].field).toBe("body");
  });

  test("a JSON array is rejected", async () => {
    const handler = route(async (request: Request) => readJson(request));
    const response = await handler(new Request("http://x/", { method: "POST", body: "[1,2]" }));
    expect(response.status).toBe(400);
  });
});
