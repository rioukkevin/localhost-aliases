import { describe, expect, test } from "bun:test";
import { ValidationError, type Alias } from "../src/types.ts";
import {
  assertValidAlias,
  hostnameFor,
  normalizeName,
  normalizeTld,
  urlFor,
  validateName,
  validatePort,
  validateTarget,
  validateTld,
} from "../src/validation.ts";

function alias(partial: Partial<Alias>): Alias {
  return {
    id: "id-1",
    name: "myapp",
    port: 3000,
    target: "127.0.0.1",
    projectPath: null,
    description: null,
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("normalizeName", () => {
  test("trims, lowercases and strips trailing dots", () => {
    expect(normalizeName("  MyApp.  ")).toBe("myapp");
    expect(normalizeName("API.MyApp...")).toBe("api.myapp");
  });

  test("folds compatibility unicode forms (NFKC)", () => {
    expect(normalizeName("ＭＹＡＰＰ")).toBe("myapp");
  });

  test("leaves non-ascii letters in place so validation can reject them", () => {
    expect(normalizeName("CAFÉ")).toBe("café");
  });

  test("is total on non-strings", () => {
    expect(normalizeName(undefined as unknown as string)).toBe("");
  });
});

describe("normalizeTld", () => {
  test("strips leading and trailing dots", () => {
    expect(normalizeTld(".Local.")).toBe("local");
  });
});

describe("validateName", () => {
  test.each(["myapp", "my-app", "api.myapp", "a", "a1-b2.c3", "x".repeat(63)])(
    "accepts %p",
    (name) => {
      expect(validateName(name)).toEqual([]);
    },
  );

  test("accepts uppercase input by normalizing it", () => {
    expect(validateName("MyApp")).toEqual([]);
  });

  test.each([
    ["", "empty"],
    ["   ", "blank"],
    ["-myapp", "leading hyphen"],
    ["myapp-", "trailing hyphen"],
    ["my_app", "underscore"],
    ["my app", "space"],
    ["my#app", "hash"],
    ["café", "non-ascii"],
    ["мойапп", "cyrillic"],
    ["api..myapp", "empty label"],
    [".myapp", "leading dot"],
    ["x".repeat(64), "label too long"],
  ])("rejects %p (%s)", (name) => {
    expect(validateName(name).length).toBeGreaterThan(0);
    expect(validateName(name)[0]!.field).toBe("name");
  });

  test("rejects names longer than 253 characters", () => {
    const long = new Array(6).fill("x".repeat(50)).join(".");
    expect(long.length).toBeGreaterThan(253);
    expect(validateName(long).length).toBe(1);
  });

  test.each(["localhost", "broadcasthost", "local", "LOCALHOST", " localhost. "])(
    "rejects reserved name %p",
    (name) => {
      const issues = validateName(name);
      expect(issues.length).toBe(1);
      expect(issues[0]!.message).toContain("reserved");
    },
  );

  test("does not reject a reserved word used as a label of a longer name", () => {
    expect(validateName("api.localhost")).toEqual([]);
  });
});

describe("validatePort", () => {
  test.each([1, 80, 3000, 65535])("accepts %p", (port) => {
    expect(validatePort(port)).toEqual([]);
  });

  test.each([0, -1, 65536, 99999, 3000.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects %p",
    (port) => {
      expect(validatePort(port).length).toBe(1);
    },
  );

  test.each([["3000"], [null], [undefined], [{}], [[3000]], [true]])(
    "rejects non-number %p",
    (port) => {
      const issues = validatePort(port);
      expect(issues.length).toBe(1);
      expect(issues[0]!.field).toBe("port");
    },
  );
});

describe("validateTarget", () => {
  test.each(["127.0.0.1", "::1", "localhost", "  LOCALHOST  "])("accepts %p", (target) => {
    expect(validateTarget(target)).toEqual([]);
  });

  test.each(["", "0.0.0.0", "192.168.1.10", "example.com", "127.0.0.2", "10.0.0.1"])(
    "rejects %p",
    (target) => {
      const issues = validateTarget(target);
      expect(issues.length).toBe(1);
      expect(issues[0]!.field).toBe("target");
    },
  );
});

describe("validateTld", () => {
  test.each(["local", "test", "dev", "internal.local", ".local"])("accepts %p", (tld) => {
    expect(validateTld(tld)).toEqual([]);
  });

  test.each(["", "   ", "loc al", "-local", "local-", "lo..cal", "123", "x".repeat(64)])(
    "rejects %p",
    (tld) => {
      const issues = validateTld(tld);
      expect(issues.length).toBe(1);
      expect(issues[0]!.field).toBe("tld");
    },
  );
});

describe("assertValidAlias", () => {
  test("passes for a minimal valid input", () => {
    expect(() => assertValidAlias({ name: "myapp", port: 3000 }, [])).not.toThrow();
  });

  test("collects every issue in one ValidationError", () => {
    try {
      assertValidAlias({ name: "-bad-", port: 0, target: "example.com" }, []);
      throw new Error("expected a ValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const fields = (error as ValidationError).issues.map((i) => i.field).sort();
      expect(fields).toEqual(["name", "port", "target"]);
    }
  });

  test("rejects a name already used, case-insensitively", () => {
    const existing = [alias({ id: "a", name: "myapp" })];
    expect(() => assertValidAlias({ name: "MyApp", port: 4000 }, existing)).toThrow(
      ValidationError,
    );
    expect(() => assertValidAlias({ name: "  myapp. ", port: 4000 }, existing)).toThrow(
      ValidationError,
    );
  });

  test("allows a different name against the same existing set", () => {
    const existing = [alias({ id: "a", name: "myapp" })];
    expect(() => assertValidAlias({ name: "other", port: 4000 }, existing)).not.toThrow();
  });

  test("excludeId lets an alias keep its own name on update", () => {
    const existing = [alias({ id: "a", name: "myapp" })];
    expect(() =>
      assertValidAlias({ name: "myapp", port: 4000 }, existing, { excludeId: "a" }),
    ).not.toThrow();
    expect(() =>
      assertValidAlias({ name: "myapp", port: 4000 }, existing, { excludeId: "b" }),
    ).toThrow(ValidationError);
  });

  test("skips target validation when it is not provided", () => {
    expect(() => assertValidAlias({ name: "myapp", port: 3000 }, [])).not.toThrow();
    expect(() =>
      assertValidAlias({ name: "myapp", port: 3000, target: "::1" }, []),
    ).not.toThrow();
  });

  test("reports the uniqueness clash on the name field", () => {
    const existing = [alias({ id: "a", name: "myapp" })];
    try {
      assertValidAlias({ name: "myapp", port: 4000 }, existing);
      throw new Error("expected a ValidationError");
    } catch (error) {
      const issues = (error as ValidationError).issues;
      expect(issues.some((i) => i.field === "name" && i.message.includes("already used"))).toBe(
        true,
      );
    }
  });
});

describe("hostnameFor", () => {
  test("joins the normalized name and tld", () => {
    expect(hostnameFor("MyApp", "local")).toBe("myapp.local");
    expect(hostnameFor("api.myapp", ".TEST.")).toBe("api.myapp.test");
  });

  test("returns the bare name when the tld is empty", () => {
    expect(hostnameFor("myapp", "")).toBe("myapp");
  });
});

describe("urlFor", () => {
  test("omits the default port for the scheme", () => {
    expect(urlFor("myapp", "local", false, 80)).toBe("http://myapp.local");
    expect(urlFor("myapp", "local", true, 443)).toBe("https://myapp.local");
  });

  test("keeps a non-default port", () => {
    expect(urlFor("myapp", "local", false, 8080)).toBe("http://myapp.local:8080");
    expect(urlFor("myapp", "local", true, 8443)).toBe("https://myapp.local:8443");
  });

  test("443 on http and 80 on https are not defaults", () => {
    expect(urlFor("myapp", "local", false, 443)).toBe("http://myapp.local:443");
    expect(urlFor("myapp", "local", true, 80)).toBe("https://myapp.local:80");
  });
});
