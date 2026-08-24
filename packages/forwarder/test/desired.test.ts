/**
 * The security boundary, exercised directly.
 *
 * desired-state.json is user-writable and read by a root process, so every test here is an
 * attack: the question is never "does the happy path work" but "what does root refuse".
 * The rule under test is all-or-nothing — one bad entry must reject the whole file, because
 * a per-entry skip would let an attacker delete an alias by appending a broken one.
 */
import { describe, expect, test } from "bun:test";
import { parseDesiredState, isLoopbackIpv4, MAX_ENTRIES } from "../src/desired.ts";
import { desiredState } from "./helpers.ts";

const parse = (state: unknown) => parseDesiredState(JSON.stringify(state));

/** Every rejection carries a reason; a silent refusal would be unusable in a log. */
function rejected(state: unknown): string[] {
  const result = parse(state);
  expect(result.plan).toBeNull();
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors;
}

describe("a well-formed file", () => {
  test("passes through, field for field", () => {
    const { plan, errors, warnings } = parse(desiredState());
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(plan).toEqual({
      hosts: [
        { ip: "127.0.0.2", hostname: "index.test" },
        { ip: "127.0.0.3", hostname: "myapp.test" },
      ],
      loopbackIps: ["127.0.0.2", "127.0.0.3"],
      routes: [
        { ip: "127.0.0.2", listenPort: 80, targetPort: 7788, hostname: "index.test" },
        { ip: "127.0.0.3", listenPort: 80, targetPort: 3000, hostname: "myapp.test" },
      ],
    });
  });

  test("an empty state is legal: it means remove everything we manage", () => {
    const { plan, errors } = parse({ hosts: [], loopbackIps: [], routes: [] });
    expect(errors).toEqual([]);
    expect(plan).toEqual({ hosts: [], loopbackIps: [], routes: [] });
  });

  test("nothing is carried over from the input object", () => {
    const { plan } = parse({
      ...desiredState(),
      // A field we do not know about must not reach the agent.
      command: "rm -rf /",
    });
    expect(Object.keys(plan ?? {}).sort()).toEqual(["hosts", "loopbackIps", "routes"]);
  });
});

describe("the file itself", () => {
  test("invalid JSON is a reason, not a throw", () => {
    // Raw text, not JSON.stringify: this is the half-written file case.
    expect(parseDesiredState("{ not json").plan).toBeNull();
    expect(parseDesiredState("{ not json").errors[0]).toContain("not valid JSON");
    expect(parseDesiredState("").errors[0]).toContain("not valid JSON");
    expect(parseDesiredState('{"hosts":[],"loopbackIps":[],"rou').errors[0]).toContain("not valid JSON");
  });

  test("an array, a string and null are all refused", () => {
    for (const shape of [[], "hello", null, 42]) {
      expect(parseDesiredState(JSON.stringify(shape)).plan).toBeNull();
    }
  });

  test("a missing or mistyped section is refused", () => {
    expect(rejected({ hosts: [], routes: [] })[0]).toContain("loopbackIps");
    expect(rejected({ hosts: {}, loopbackIps: [], routes: [] })[0]).toContain("hosts");
    expect(rejected({ hosts: [], loopbackIps: [], routes: "all" })[0]).toContain("routes");
  });

  test("an absurd number of entries is refused before anything is parsed", () => {
    const many = Array.from({ length: MAX_ENTRIES + 1 }, () => "127.0.0.2");
    expect(rejected({ hosts: [], loopbackIps: many, routes: [] })[0]).toContain("more than 512");
  });
});

describe("loopback addresses", () => {
  test("127.0.0.1 can never be asked for", () => {
    // The real loopback. If it could enter the plan, the agent could be told to REMOVE it.
    expect(rejected(desiredState({ loopbackIps: ["127.0.0.1"] }))[0]).toContain("outside 127.0.0.2-254");
  });

  test("an address outside the pool is refused", () => {
    for (const ip of ["127.0.1.5", "127.0.0.255", "10.0.0.5", "0.0.0.0", "::1", "127.0.0.02"]) {
      expect(rejected(desiredState({ loopbackIps: [ip], hosts: [], routes: [] }))[0]).toContain(
        "outside 127.0.0.2-254",
      );
    }
  });

  test("a duplicate is refused rather than quietly collapsed", () => {
    expect(
      rejected(desiredState({ loopbackIps: ["127.0.0.2", "127.0.0.2"], hosts: [], routes: [] })),
    ).toEqual(["loopbackIps lists 127.0.0.2 twice"]);
  });
});

describe("hostnames", () => {
  test("a newline cannot smuggle a second /etc/hosts line", () => {
    const attack = "evil.test\n127.0.0.1\tbank.example.com";
    expect(rejected(desiredState({ hosts: [{ ip: "127.0.0.2", hostname: attack }] }))[0]).toContain(
      "invalid hostname",
    );
  });

  test("whitespace, a comment marker and an empty label are all refused", () => {
    for (const hostname of ["two words.test", "a#b.test", "a..test", ".test", "test.", ""]) {
      expect(rejected(desiredState({ hosts: [{ ip: "127.0.0.2", hostname }] }))[0]).toContain(
        "invalid hostname",
      );
    }
  });

  test("an over-long label and an over-long name are refused", () => {
    const label = "a".repeat(64);
    expect(rejected(desiredState({ hosts: [{ ip: "127.0.0.2", hostname: `${label}.test` }] })).length).toBe(1);
    const long = `${"a".repeat(60)}.`.repeat(5) + "test";
    expect(parse(desiredState({ hosts: [{ ip: "127.0.0.2", hostname: long }] })).plan).toBeNull();
  });

  test("the system's own names are refused", () => {
    for (const hostname of ["localhost", "broadcasthost", "local", "localhost.localdomain", "x.localhost"]) {
      const errors = rejected(desiredState({ hosts: [{ ip: "127.0.0.2", hostname }] }));
      expect(errors.join(" ")).toMatch(/belongs to the system|invalid hostname/);
    }
  });

  test("a hosts entry pointing at an address nobody allocated is refused", () => {
    expect(
      rejected(
        desiredState({
          hosts: [{ ip: "127.0.0.9", hostname: "myapp.test" }],
          loopbackIps: ["127.0.0.2"],
          routes: [],
        }),
      )[0],
    ).toContain("not in loopbackIps");
  });

  test("the same hostname twice is refused", () => {
    expect(
      rejected(
        desiredState({
          hosts: [
            { ip: "127.0.0.2", hostname: "myapp.test" },
            { ip: "127.0.0.3", hostname: "myapp.test" },
          ],
          routes: [],
        }),
      )[0],
    ).toContain("twice");
  });
});

describe("routes", () => {
  test("a non-loopback bind address is refused", () => {
    // This is the one that would put someone's dev server on the network.
    for (const ip of ["0.0.0.0", "192.168.1.20", "10.1.2.3", "255.255.255.255"]) {
      expect(rejected(desiredState({ routes: [{ ip, listenPort: 80, targetPort: 3000, hostname: "a.test" }] }))[0])
        .toContain("not a loopback address");
    }
  });

  test("127.0.0.1 is a legal bind address ABOVE 1024; that is how a root component is tested without root", () => {
    const { plan } = parse(
      desiredState({
        hosts: [],
        loopbackIps: [],
        routes: [{ ip: "127.0.0.1", listenPort: 9999, targetPort: 3000, hostname: "a.test" }],
      }),
    );
    expect(plan?.routes[0]?.ip).toBe("127.0.0.1");
  });

  // The escalation this rule exists for: root binds a port the caller could not bind itself,
  // on the REAL localhost, and splices it to whatever high port the caller is listening on.
  test("root is never asked to hold a privileged port on an off-pool loopback address", () => {
    for (const listenPort of [22, 25, 80, 443, 631, 1, 1024]) {
      const [reason] = rejected(
        desiredState({
          hosts: [],
          loopbackIps: [],
          routes: [{ ip: "127.0.0.1", listenPort, targetPort: 31337, hostname: "a.test" }],
        }),
      );
      expect(reason).toContain("privileged port");
    }
  });

  test("the rule holds for every off-pool loopback address, not only 127.0.0.1", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "127.0.0.255", "127.255.255.254"]) {
      expect(
        rejected(desiredState({ hosts: [], loopbackIps: [], routes: [{ ip, listenPort: 80, targetPort: 3000, hostname: "a.test" }] }))[0],
      ).toContain("privileged port");
    }
  });

  test("1025 on an off-pool loopback address is still fine: it grants nothing root-only", () => {
    const { plan } = parse(
      desiredState({ hosts: [], loopbackIps: [], routes: [{ ip: "127.0.0.1", listenPort: 1025, targetPort: 3000, hostname: "a.test" }] }),
    );
    expect(plan?.routes).toHaveLength(1);
  });

  test("port 80 on a pool address the file also allocates is the product, and stays legal", () => {
    const { plan } = parse(
      desiredState({
        hosts: [{ ip: "127.0.0.2", hostname: "a.test" }],
        loopbackIps: ["127.0.0.2"],
        routes: [{ ip: "127.0.0.2", listenPort: 80, targetPort: 3000, hostname: "a.test" }],
      }),
    );
    expect(plan?.routes[0]?.listenPort).toBe(80);
  });

  test("a pool address the same file does not ask us to create cannot be bound", () => {
    expect(
      rejected({
        hosts: [],
        loopbackIps: ["127.0.0.2"],
        routes: [{ ip: "127.0.0.5", listenPort: 80, targetPort: 3000, hostname: "a.test" }],
      })[0],
    ).toContain("not in loopbackIps");
  });

  test("ports are integers in range", () => {
    for (const port of [0, -1, 65536, 1.5, "80", null]) {
      expect(rejected(desiredState({ routes: [{ ip: "127.0.0.2", listenPort: port, targetPort: 3000, hostname: "a.test" }] })).length)
        .toBeGreaterThan(0);
      expect(rejected(desiredState({ routes: [{ ip: "127.0.0.2", listenPort: 80, targetPort: port, hostname: "a.test" }] })).length)
        .toBeGreaterThan(0);
    }
  });

  test("two routes cannot claim the same listener", () => {
    expect(
      rejected(
        desiredState({
          routes: [
            { ip: "127.0.0.2", listenPort: 80, targetPort: 3000, hostname: "a.test" },
            { ip: "127.0.0.2", listenPort: 80, targetPort: 4000, hostname: "b.test" },
          ],
        }),
      )[0],
    ).toContain("duplicates 127.0.0.2:80");
  });
});

describe("hints", () => {
  test("a good hint survives", () => {
    const { plan, warnings } = parse(
      desiredState({
        routes: [
          {
            ip: "127.0.0.2",
            listenPort: 80,
            targetPort: 3000,
            hostname: "a.test",
            hint: { framework: "Next.js", command: "next dev -p 3000" },
          },
        ],
      }),
    );
    expect(warnings).toEqual([]);
    expect(plan?.routes[0]?.hint).toEqual({ framework: "Next.js", command: "next dev -p 3000" });
  });

  test("an unusable hint is dropped, and the route is kept", () => {
    // A hint is advisory (types.ts). Costing the user their aliases over one would be worse
    // than showing no command.
    for (const hint of [42, [], { framework: 1, command: "x" }, { framework: "x" }]) {
      const { plan, warnings } = parse(
        desiredState({ routes: [{ ip: "127.0.0.2", listenPort: 80, targetPort: 3000, hostname: "a.test", hint }] }),
      );
      expect(plan?.routes).toHaveLength(1);
      expect(plan?.routes[0]?.hint).toBeUndefined();
      expect(warnings).toHaveLength(1);
    }
  });

  test("control characters and absurd lengths are dropped", () => {
    const cases = [
      { framework: "x", command: "next dev\u0000-p 3000" },
      { framework: "x", command: "line one\u001b[2Jline two" },
      { framework: "x", command: "a".repeat(201) },
      { framework: "a".repeat(65), command: "x" },
    ];
    for (const hint of cases) {
      const { plan, warnings } = parse(
        desiredState({ routes: [{ ip: "127.0.0.2", listenPort: 80, targetPort: 3000, hostname: "a.test", hint }] }),
      );
      expect(plan?.routes[0]?.hint).toBeUndefined();
      expect(warnings).toHaveLength(1);
    }
  });
});

test("isLoopbackIpv4 accepts 127/8 and nothing else", () => {
  expect(isLoopbackIpv4("127.0.0.1")).toBe(true);
  expect(isLoopbackIpv4("127.255.255.254")).toBe(true);
  expect(isLoopbackIpv4("128.0.0.1")).toBe(false);
  expect(isLoopbackIpv4("127.0.0")).toBe(false);
  expect(isLoopbackIpv4(undefined)).toBe(false);
});
