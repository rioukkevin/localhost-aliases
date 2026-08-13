#!/usr/bin/env bun
/**
 * stdio entrypoint. Compiled into the app bundle as Contents/Resources/mcp by
 * packages/build/bundle.sh; run through Bun from a checkout in development.
 *
 * Nothing may be written to stdout except MCP frames — stdout is the transport.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

const server = createServer();
await server.connect(new StdioServerTransport());
