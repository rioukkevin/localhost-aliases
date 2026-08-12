/**
 * The transparency text must name the files this process will actually touch.
 *
 * Spawns the real server over stdio with LA_HOSTS_PATH / LA_CONFIG_DIR pointed at
 * temp paths and asserts the instructions describe THOSE, never the production
 * defaults. Nothing here reads or writes either path — they are only interpolated.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_ENTRY, freePort } from "./fixtures/mcp-harness.ts";

const REAL_HOSTS = "/etc/hosts";
const REAL_CONFIG = join(process.env.HOME ?? "", ".config", "localhost-aliases");

describe("transparency text follows the runtime paths", () => {
  let client: Client;
  let hostsPath: string;
  let configDir: string;
  let tempRoot: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "la-mcp-paths-"));
    hostsPath = join(tempRoot, "hosts");
    configDir = join(tempRoot, "config");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", SERVER_ENTRY],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        LA_DASHBOARD_PORT: String(await freePort()),
        LA_HOSTS_PATH: hostsPath,
        LA_CONFIG_DIR: configDir,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "mcp-paths-test", version: "0.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("server instructions name the overridden paths, not the real ones", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain(hostsPath);
    expect(instructions).toContain(join(configDir, "config.json"));
    expect(instructions).toContain(join(configDir, "ca"));
    expect(instructions).not.toContain(REAL_HOSTS);
    expect(instructions).not.toContain(REAL_CONFIG);
  });

  test("get_usage_instructions names the overridden paths, not the real ones", async () => {
    const result = (await client.callTool({ name: "get_usage_instructions", arguments: {} })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = result.content.map((part) => part.text ?? "").join("\n");
    expect(result.isError).toBeFalsy();
    expect(text).toContain(hostsPath);
    expect(text).toContain(join(configDir, "config.json"));
    expect(text).toContain(join(configDir, "ca"));
    expect(text).not.toContain(REAL_HOSTS);
    expect(text).not.toContain(REAL_CONFIG);
  });

  test("tool descriptions follow the same paths", async () => {
    const { tools } = await client.listTools();
    const descriptions = tools.map((tool) => tool.description ?? "").join("\n");
    expect(descriptions).toContain(hostsPath);
    expect(descriptions).not.toContain(REAL_HOSTS);
    expect(descriptions).not.toContain(REAL_CONFIG);
  });
});
