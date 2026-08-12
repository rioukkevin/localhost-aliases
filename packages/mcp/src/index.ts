#!/usr/bin/env bun
/**
 * stdio entrypoint. stdout belongs to the JSON-RPC stream — every diagnostic must
 * go to stderr or it corrupts the protocol.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.ts";
import { baseUrl } from "./client.ts";

const server = createServer();
await server.connect(new StdioServerTransport());
console.error(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio (dashboard: ${baseUrl()})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
