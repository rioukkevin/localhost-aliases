import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseRoutes, readRoutes, routeKey } from "../src/routes.ts";
import { cleanup, tempDir } from "./helpers.ts";

const good = [{ ip: "127.0.0.2", listenPort: 80, targetPort: 3000, hostname: "a.test" }];

describe("parseRoutes", () => {
  test("accepts a bare array", () => {
    const { routes, errors } = parseRoutes(JSON.stringify(good));
    expect(errors).toEqual([]);
    expect(routes).toEqual(good);
  });

  test("accepts the desired-state wrapper", () => {
    const { routes } = parseRoutes(JSON.stringify({ hosts: [], loopbackIps: [], routes: good }));
    expect(routes).toEqual(good);
  });

  test("reports invalid JSON instead of throwing", () => {
    const { routes, errors } = parseRoutes("{nope");
    expect(routes).toEqual([]);
    expect(errors[0]).toContain("not valid JSON");
  });

  test("skips bad entries and keeps the good ones", () => {
    const { routes, errors } = parseRoutes(
      JSON.stringify([
        { ip: "999.1.1.1", listenPort: 80, targetPort: 1, hostname: "bad" },
        { ip: "127.0.0.2", listenPort: 0, targetPort: 1, hostname: "bad" },
        { ip: "127.0.0.2", listenPort: 80, targetPort: 70000, hostname: "bad" },
        null,
        ...good,
      ]),
    );
    expect(routes).toEqual(good);
    expect(errors).toHaveLength(4);
  });

  test("drops a duplicate ip:listenPort", () => {
    const { routes, errors } = parseRoutes(
      JSON.stringify([...good, { ...good[0], targetPort: 4000, hostname: "b.test" }]),
    );
    expect(routes).toHaveLength(1);
    expect(errors[0]).toContain("duplicate 127.0.0.2:80");
  });

  test("falls back to ip:port when hostname is missing", () => {
    const { routes } = parseRoutes(JSON.stringify([{ ip: "127.0.0.3", listenPort: 80, targetPort: 5000 }]));
    expect(routes[0]?.hostname).toBe("127.0.0.3:80");
  });
});

test("routeKey identifies a listener", () => {
  expect(routeKey({ ip: "127.0.0.2", listenPort: 80 })).toBe("127.0.0.2:80");
});

describe("readRoutes", () => {
  test("a missing file means no routes, not an error", async () => {
    const dir = await tempDir();
    const result = await readRoutes(join(dir, "routes.json"));
    expect(result).toEqual({ routes: [], errors: [] });
    await cleanup(dir);
  });

  test("an empty file means no routes", async () => {
    const dir = await tempDir();
    const path = join(dir, "routes.json");
    await Bun.write(path, "  \n");
    expect(await readRoutes(path)).toEqual({ routes: [], errors: [] });
    await cleanup(dir);
  });
});
