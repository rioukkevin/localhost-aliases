import { describe, expect, test } from "bun:test";
import { forwardRequestHeaders, forwardResponseHeaders, forwardWebSocketHeaders } from "../src/headers.ts";

const ctx = { clientIp: "127.0.0.1", proto: "http", host: "myapp.local" };

describe("forwardRequestHeaders", () => {
  test("drops every hop-by-hop header", () => {
    const source = new Headers({
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      upgrade: "h2c",
      te: "trailers",
      trailer: "expires",
      "proxy-authorization": "Basic x",
      "proxy-anything": "x",
      "content-type": "application/json",
    });
    const out = forwardRequestHeaders(source, ctx);
    for (const dropped of ["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-anything"]) {
      expect(out.get(dropped)).toBeNull();
    }
    expect(out.get("content-type")).toBe("application/json");
  });

  test("drops headers named by the Connection header (RFC 7230 6.1)", () => {
    const source = new Headers({ connection: "close, X-Custom-Hop", "x-custom-hop": "secret", "x-keep": "yes" });
    const out = forwardRequestHeaders(source, ctx);
    expect(out.get("x-custom-hop")).toBeNull();
    expect(out.get("x-keep")).toBe("yes");
  });

  test("sets the forwarding headers and appends to an existing X-Forwarded-For", () => {
    const out = forwardRequestHeaders(new Headers({ "x-forwarded-for": "10.1.1.1" }), ctx);
    expect(out.get("x-forwarded-for")).toBe("10.1.1.1, 127.0.0.1");
    expect(out.get("x-forwarded-proto")).toBe("http");
    expect(out.get("x-forwarded-host")).toBe("myapp.local");
  });

  test("forces identity encoding so Bun's transparent decompression cannot desync the body", () => {
    const out = forwardRequestHeaders(new Headers({ "accept-encoding": "gzip, br" }), ctx);
    expect(out.get("accept-encoding")).toBe("identity");
  });

  test("omits X-Forwarded-For when the client IP is unknown", () => {
    const out = forwardRequestHeaders(new Headers(), { ...ctx, clientIp: null });
    expect(out.get("x-forwarded-for")).toBeNull();
  });
});

describe("forwardResponseHeaders", () => {
  test("keeps content-length when nothing was compressed", () => {
    const out = forwardResponseHeaders(new Headers({ "content-length": "12", "content-type": "text/html" }));
    expect(out.get("content-length")).toBe("12");
  });

  test("drops content-encoding and the now-wrong content-length together", () => {
    const out = forwardResponseHeaders(new Headers({ "content-encoding": "gzip", "content-length": "12", "x-app": "1" }));
    expect(out.get("content-encoding")).toBeNull();
    expect(out.get("content-length")).toBeNull();
    expect(out.get("x-app")).toBe("1");
  });

  test("strips hop-by-hop response headers", () => {
    const out = forwardResponseHeaders(new Headers({ connection: "close", "transfer-encoding": "chunked", "set-cookie": "a=b" }));
    expect(out.get("connection")).toBeNull();
    expect(out.get("transfer-encoding")).toBeNull();
    expect(out.get("set-cookie")).toBe("a=b");
  });
});

describe("forwardWebSocketHeaders", () => {
  test("removes the handshake headers the client library regenerates", () => {
    const source = new Headers({
      "sec-websocket-key": "abc",
      "sec-websocket-version": "13",
      "sec-websocket-extensions": "permessage-deflate",
      connection: "Upgrade",
      upgrade: "websocket",
      cookie: "session=1",
    });
    const out = forwardWebSocketHeaders(source, ctx);
    expect(Object.keys(out).some((name) => name.startsWith("sec-websocket-"))).toBe(false);
    expect(out.connection).toBeUndefined();
    expect(out.upgrade).toBeUndefined();
    expect(out.cookie).toBe("session=1");
    expect(out["x-forwarded-host"]).toBe("myapp.local");
  });
});
