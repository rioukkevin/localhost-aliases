#!/usr/bin/env bun
/**
 * Release notes for a commit range, written by the local `claude` CLI.
 *
 * This is the machine half of the pre-push hook (.githooks/pre-push). CI has its own path —
 * release-notes.ts calls the Anthropic API with an API key — and the two must agree, so the
 * prompt, the sanitiser and the fallback are IMPORTED from release-notes.ts rather than
 * restated here. Notes written on your Mac and notes written by the workflow come out the
 * same shape because they come from the same prompt.
 *
 *   bun run packages/build/write-notes.ts --range v2.0.0..HEAD --out release-notes/unreleased.md
 *
 * DEGRADE, NEVER BLOCK THE PUSH. No `claude` on PATH, a non-zero exit, a timeout, an empty
 * answer: every one of them leaves the previous file untouched and exits 0. A push is never
 * refused because nobody could write nice notes for it. The exit code means "the file on disk
 * changed", not "the model was happy" — see EXIT_CHANGED.
 *
 * THE COMMIT LOG IS UNTRUSTED INPUT, AND HERE IT IS MORE DANGEROUS THAN IN CI. The workflow
 * hands the log to a bare API call that has no tools. This runs on a developer's machine
 * against a CLI that does, so a commit message shaped as an instruction could otherwise ask
 * for a file read or a shell command. Hence --disallowed-tools and --strict-mcp-config below:
 * the model is given no tool it could be talked into using, and no MCP server to reach.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  fallbackNotes,
  MODEL,
  parseCommitLog,
  renderCommitLog,
  sanitizeNotes,
  SYSTEM_PROMPT,
} from "./release-notes.ts";

/** Exit code meaning "the notes on disk are new or different". The hook commits on this. */
export const EXIT_CHANGED = 10;

/** Long enough for a big release, short enough that a hung CLI does not hold a push open. */
const TIMEOUT_MS = 180_000;

/**
 * Every tool the CLI could otherwise offer. Named explicitly rather than relying on the model
 * not to reach for one: the point is that an injected instruction has nothing to reach for.
 */
const NO_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return "";
  return out.trim();
}

/**
 * Ask the CLI, and accept the answer only when it is one.
 *
 * The commit log goes in on stdin rather than in argv: it is arbitrary text of arbitrary
 * length from arbitrary authors, and an argument list is neither the place nor the size for it.
 */
async function ask(userTurn: string): Promise<string> {
  let proc;
  try {
    proc = Bun.spawn(
      [
        "claude",
        "--print",
        "--system-prompt",
        SYSTEM_PROMPT,
        "--model",
        MODEL,
        "--output-format",
        "text",
        "--strict-mcp-config",
        "--disallowed-tools",
        ...NO_TOOLS,
      ],
      { stdin: new Blob([userTurn]), stdout: "pipe", stderr: "pipe" },
    );
  } catch (error: unknown) {
    // No `claude` on PATH, or it is not executable. Not an error worth a stack trace: the
    // caller falls back to the commit list exactly as it does for a refusal.
    console.log(`write-notes: cannot run claude — ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }

  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      console.log(`write-notes: claude exited non-zero — ${stderr.split("\n")[0] ?? "no output"}`);
      return "";
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const range = arg("range");
  const outPath = arg("out");
  if (!range || !outPath) {
    throw new Error("usage: write-notes.ts --range <rev-range> --out <file>");
  }

  const commits = parseCommitLog(await git(["log", "--no-merges", "--pretty=format:%H%x09%s", range]));
  if (commits.length === 0) {
    console.log(`write-notes: no commits in ${range}, nothing to write`);
    return;
  }

  const answer = sanitizeNotes(await ask(renderCommitLog(commits)));
  // An empty answer is the CLI having failed in one of its many ways. The grouped commit list
  // is never wrong, only less pleasant, and is what CI would have fallen back to anyway.
  const notes = answer || fallbackNotes(commits);
  console.log(
    answer
      ? `write-notes: ${MODEL} wrote ${notes.length} chars from ${commits.length} commits`
      : `write-notes: falling back to the commit list (${commits.length} commits)`,
  );

  const contents = `${notes}\n`;
  const existing = await Bun.file(outPath)
    .text()
    .catch(() => "");
  if (existing === contents) {
    console.log(`write-notes: ${outPath} is already up to date`);
    return;
  }

  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, contents);
  console.log(`write-notes: wrote ${outPath}`);
  process.exit(EXIT_CHANGED);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // Exit 0 on purpose: a push is not blocked because notes could not be written.
    console.log(`write-notes: ${error instanceof Error ? error.message : String(error)}`);
  });
}
