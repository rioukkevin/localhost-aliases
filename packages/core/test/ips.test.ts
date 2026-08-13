import { describe, expect, test } from "bun:test";
import { allocateIp, isPoolIp, isValidIpv4, parseLoopbackIps, poolIps, POOL_SIZE } from "../src/ips.ts";

const IFCONFIG_LO0 = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	options=1203<RXCSUM,TXCSUM,TXSTATUS,SW_TIMESTAMP>
	inet 127.0.0.1 netmask 0xff000000
	inet6 ::1 prefixlen 128 
	inet6 fe80::1%lo0 prefixlen 64 scopeid 0x1 
	inet 127.0.0.2 netmask 0xff000000
	inet 127.0.0.3 netmask 0xff000000
	nd6 options=201<PERFORMNUD,DAD>
`;

const IFCONFIG_ALL = `${IFCONFIG_LO0}en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	inet 192.168.1.24 netmask 0xffffff00 broadcast 192.168.1.255
`;

describe("pool membership", () => {
  test("pool covers 127.0.0.2 .. 127.0.0.254", () => {
    expect(POOL_SIZE).toBe(253);
    expect(poolIps()[0]).toBe("127.0.0.2");
    expect(poolIps().at(-1)).toBe("127.0.0.254");
  });

  test.each(["127.0.0.2", "127.0.0.254", "127.0.0.99"])("isPoolIp %s", (ip) =>
    expect(isPoolIp(ip)).toBe(true),
  );
  test.each(["127.0.0.1", "127.0.0.255", "127.0.1.2", "192.168.1.2", "127.0.0.02", "nope", ""])(
    "not in pool: %p",
    (ip) => expect(isPoolIp(ip)).toBe(false),
  );

  test("isValidIpv4 rejects out-of-range and padded octets", () => {
    expect(isValidIpv4("127.0.0.256")).toBe(false);
    expect(isValidIpv4("127.00.0.1")).toBe(false);
    expect(isValidIpv4("127.0.0.1")).toBe(true);
  });
});

describe("allocateIp", () => {
  test("first allocation is the first pool address", () => {
    expect(allocateIp([])).toBe("127.0.0.2");
    expect(allocateIp()).toBe("127.0.0.2");
  });

  test("returns the lowest free address so allocation stays dense", () => {
    expect(allocateIp(["127.0.0.2", "127.0.0.4"])).toBe("127.0.0.3");
  });

  test("ignores addresses outside the pool", () => {
    expect(allocateIp(["127.0.0.1", "192.168.0.2"])).toBe("127.0.0.2");
  });

  test("accepts a Set", () => {
    expect(allocateIp(new Set(["127.0.0.2", "127.0.0.3"]))).toBe("127.0.0.4");
  });

  test("throws a user-facing error when the pool is exhausted", () => {
    expect(() => allocateIp(poolIps())).toThrow(/All 253 loopback addresses/);
    expect(() => allocateIp(poolIps())).toThrow(/Delete an alias to free one/);
  });

  test("253 sequential allocations succeed, the 254th does not", () => {
    const taken: string[] = [];
    for (let i = 0; i < POOL_SIZE; i++) taken.push(allocateIp(taken));
    expect(taken).toHaveLength(253);
    expect(new Set(taken).size).toBe(253);
    expect(() => allocateIp(taken)).toThrow();
  });
});

describe("parseLoopbackIps", () => {
  test("reads every inet line of lo0", () => {
    expect(parseLoopbackIps(IFCONFIG_LO0)).toEqual(["127.0.0.1", "127.0.0.2", "127.0.0.3"]);
  });

  test("ignores other interfaces when given full ifconfig output", () => {
    expect(parseLoopbackIps(IFCONFIG_ALL)).toEqual(["127.0.0.1", "127.0.0.2", "127.0.0.3"]);
  });

  test("ignores inet6", () => {
    expect(parseLoopbackIps(IFCONFIG_LO0).some((ip) => ip.includes(":"))).toBe(false);
  });

  test("empty output yields nothing", () => {
    expect(parseLoopbackIps("")).toEqual([]);
  });

  test("handles CRLF", () => {
    expect(parseLoopbackIps(IFCONFIG_LO0.replace(/\n/g, "\r\n"))).toEqual([
      "127.0.0.1",
      "127.0.0.2",
      "127.0.0.3",
    ]);
  });

  test("deduplicates", () => {
    const doubled = "lo0: flags=8049<UP> mtu 16384\n\tinet 127.0.0.2 netmask 0xff000000\n\tinet 127.0.0.2 netmask 0xff000000\n";
    expect(parseLoopbackIps(doubled)).toEqual(["127.0.0.2"]);
  });

  test("pairs with isPoolIp to yield only managed addresses", () => {
    expect(parseLoopbackIps(IFCONFIG_ALL).filter(isPoolIp)).toEqual(["127.0.0.2", "127.0.0.3"]);
  });
});
