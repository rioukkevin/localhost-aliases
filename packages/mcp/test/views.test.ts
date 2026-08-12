/**
 * Normalisation is what guarantees structuredContent always matches the declared
 * output schema, even if the dashboard omits an optional field.
 */
import { describe, expect, test } from "bun:test";
import type { AliasView } from "@localhost-aliases/core";
import { renderAliasList, renderProjectList, toAliasSummary } from "../src/views.ts";

describe("views", () => {
  test("fills in everything the schema requires from a sparse payload", () => {
    const summary = toAliasSummary({ id: "1", name: "shop", port: 3000 } as AliasView);
    expect(summary).toEqual({
      id: "1",
      name: "shop",
      hostname: "shop",
      url: "http://shop",
      port: 3000,
      target: "127.0.0.1",
      projectPath: null,
      description: null,
      enabled: true,
      status: "unknown",
    });
  });

  test("an unexpected status value degrades to 'unknown'", () => {
    const summary = toAliasSummary({ id: "1", name: "shop", port: 3000, status: "weird" } as unknown as AliasView);
    expect(summary.status).toBe("unknown");
  });

  test("the empty list tells the agent what to do instead of showing nothing", () => {
    expect(renderAliasList([])).toContain("create_alias");
    expect(renderProjectList([])).toContain("link_project");
  });

  test("a rendered alias shows status, hostname, upstream and context", () => {
    const text = renderAliasList([
      toAliasSummary({
        id: "1",
        name: "shop",
        hostname: "shop.local",
        url: "http://shop.local",
        port: 3000,
        target: "127.0.0.1",
        projectPath: "/tmp/shop",
        description: "storefront",
        enabled: true,
        status: "up",
        createdAt: "",
        updatedAt: "",
      }),
    ]);
    expect(text).toContain("1 alias (1 with a live upstream)");
    expect(text).toContain("shop.local");
    expect(text).toContain("-> 127.0.0.1:3000");
    expect(text).toContain("project: /tmp/shop");
    expect(text).toContain('"storefront"');
  });
});
