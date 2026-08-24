import { describe, expect, test } from "bun:test";
import {
  assertValidAlias,
  assertValidPort,
  assertValidTld,
  hostnameFor,
  isValidLabel,
  isValidName,
  isValidPort,
  normalizeName,
  urlFor,
} from "../src/validation.ts";
import { ValidationError, type Alias } from "../src/types.ts";

function alias(partial: Partial<Alias>): Alias {
  return {
    id: "id-1",
    name: "existing",
    port: 3000,
    ip: "127.0.0.2",
    projectPath: null,
    description: null,
    enabled: true,
    reserved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function issuesFor(input: Parameters<typeof assertValidAlias>[0], existing: Alias[] = [], opts = {}) {
  try {
    assertValidAlias(input, existing, opts);
  } catch (e) {
    if (e instanceof ValidationError) return e.issues;
    throw e;
  }
  return [];
}

describe("label + name rules", () => {
  const valid = ["a", "myapp", "my-app", "a1", "0", "api.myapp", "a".repeat(63)];
  const invalid = ["", "-a", "a-", "My-App", "my_app", "a".repeat(64), "a..b", ".a", "a.", "a b", "café"];

  for (const name of valid) {
    test(`accepts ${JSON.stringify(name)}`, () => expect(isValidName(name)).toBe(true));
  }
  for (const name of invalid) {
    test(`rejects ${JSON.stringify(name)}`, () => expect(isValidName(name)).toBe(false));
  }

  test("isValidLabel rejects dotted input", () => {
    expect(isValidLabel("a.b")).toBe(false);
  });

  test("normalizeName trims and lowercases", () => {
    expect(normalizeName("  MyApp \n")).toBe("myapp");
  });
});

describe("ports", () => {
  test.each([1, 80, 3000, 65535])("accepts %p", (p) => expect(isValidPort(p)).toBe(true));
  test.each([0, -1, 65536, 3000.5, NaN, "3000", null, undefined])("rejects %p", (p) =>
    expect(isValidPort(p)).toBe(false),
  );
  test("assertValidPort throws with the field name", () => {
    try {
      assertValidPort(0, "dashboardPort");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).issues[0]!.field).toBe("dashboardPort");
    }
  });
});

describe("assertValidAlias", () => {
  test("accepts a plain alias", () => {
    expect(() => assertValidAlias({ name: "myapp", port: 3000 })).not.toThrow();
  });

  test("requires name and port on create", () => {
    const issues = issuesFor({} as never);
    expect(issues.map((i) => i.field).sort()).toEqual(["name", "port"]);
  });

  test("reports every problem at once", () => {
    const issues = issuesFor({ name: "-bad", port: 0 });
    expect(issues).toHaveLength(2);
  });

  test.each(["localhost", "broadcasthost", "local"])("rejects reserved name %s", (name) => {
    expect(issuesFor({ name, port: 3000 })[0]!.message).toContain("reserved by macOS");
  });

  test("protects the index name from user creation", () => {
    expect(issuesFor({ name: "index", port: 3000 })[0]!.message).toContain("reserved for the dashboard");
  });

  test("allows index when explicitly permitted (seeding)", () => {
    expect(issuesFor({ name: "index", port: 7788 }, [], { allowReserved: true })).toEqual([]);
  });

  test("uniqueness is case-insensitive", () => {
    const existing = [alias({ name: "myapp" })];
    expect(issuesFor({ name: "myapp", port: 3000 }, existing)[0]!.message).toContain("already exists");
  });

  test("uniqueness skips the alias being updated", () => {
    const existing = [alias({ id: "id-1", name: "myapp" })];
    expect(issuesFor({ name: "myapp", port: 3001 }, existing, { excludeId: "id-1" })).toEqual([]);
  });

  test("partial mode skips absent fields", () => {
    expect(issuesFor({ port: 4000 }, [], { partial: true })).toEqual([]);
    expect(issuesFor({ port: 0 }, [], { partial: true })).toHaveLength(1);
  });

  test("rejects a relative project path", () => {
    expect(issuesFor({ name: "a", port: 1, projectPath: "relative" })[0]!.field).toBe("projectPath");
  });

  test("accepts null project path and description", () => {
    expect(issuesFor({ name: "a", port: 1, projectPath: null, description: null })).toEqual([]);
  });

  test("rejects a name that overflows the hostname limit with its TLD", () => {
    const name = [1, 2, 3, 4].map(() => "a".repeat(63)).join(".");
    expect(issuesFor({ name, port: 1 }, [], { tld: "test" })[0]!.message).toContain("253");
  });

  test("ValidationError message lists field and message", () => {
    const err = new ValidationError([{ field: "name", message: "nope" }]);
    expect(err.message).toBe("name: nope");
  });
});

describe("tld", () => {
  test.each(["test", "internal", "lan", "home.arpa", "example"])("accepts %s", (tld) =>
    expect(() => assertValidTld(tld)).not.toThrow(),
  );
  test("accepts and normalizes surrounding case and whitespace", () => {
    expect(() => assertValidTld(" TEST ")).not.toThrow();
  });
  test.each(["", " ", ".test", "te st", "test_dev", 42, null])("rejects %p", (tld) =>
    expect(() => assertValidTld(tld)).toThrow(ValidationError),
  );
});

describe("hostnameFor / urlFor", () => {
  test("joins with a dot", () => expect(hostnameFor("myapp", "test")).toBe("myapp.test"));
  test("project aliases are http only", () => expect(urlFor("myapp", "test")).toBe("http://myapp.test"));
});
