/**
 * The managed `/etc/hosts` block.
 *
 * `renderBlock`, `parseBlock` and `applyBlock` are pure string transforms with no filesystem
 * access at all. That is deliberate: this is the one place in the system where a bug corrupts
 * a file the whole machine depends on, so the risky logic is kept trivially unit-testable and
 * the I/O around it is a thin, boring shell.
 *
 * Invariants the tests pin down:
 *  - `applyBlock` is idempotent.
 *  - Everything outside the markers is preserved byte-for-byte (CRLF, trailing spaces, a
 *    missing final newline).
 *  - An empty hostname list removes the block, and the blank lines we introduced with it.
 */
import { chmod, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HOSTS_BEGIN, HOSTS_END, RESERVED_NAMES } from "./types.ts";
import { HOSTS_PATH } from "./paths.ts";

/** Explains the block to anyone who opens /etc/hosts in an editor. Ignored by `parseBlock`. */
const MANAGED_NOTE = "# Managed by localhost-aliases. Edit aliases in the dashboard, not here.";

const IPV4_LOOPBACK = "127.0.0.1";
/** Emitted alongside the A record: macOS resolvers try AAAA first for many lookups. */
const IPV6_LOOPBACK = "::1";

const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
/** Same expression the architecture spec mandates for the privileged helper. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const DSCACHEUTIL = "/usr/bin/dscacheutil";
const KILLALL = "/usr/bin/killall";

// ---------------------------------------------------------------------------
// Line model
// ---------------------------------------------------------------------------

/** A physical line plus the exact terminator that followed it: "", "\n" or "\r\n". */
interface Line {
  text: string;
  eol: string;
}

/**
 * Splits into lines while remembering each terminator, so `joinLines(splitLines(s)) === s`
 * for every input. This is what makes byte-for-byte preservation possible.
 * A trailing `{ text: "", eol: "" }` entry represents "the content ended with a newline".
 */
function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let cursor = 0;
  for (;;) {
    const nl = content.indexOf("\n", cursor);
    if (nl === -1) {
      lines.push({ text: content.slice(cursor), eol: "" });
      return lines;
    }
    const crlf = nl > cursor && content[nl - 1] === "\r";
    lines.push({ text: content.slice(cursor, crlf ? nl - 1 : nl), eol: crlf ? "\r\n" : "\n" });
    cursor = nl + 1;
  }
}

function isBlank(line: Line): boolean {
  return line.text.trim() === "";
}

function isMarker(line: Line, marker: string): boolean {
  return line.text.trim() === marker;
}

/**
 * Inclusive `[beginIndex, endIndex]` ranges of every managed block.
 *
 * Decision, deliberate: when a BEGIN marker has no matching END anywhere after it, we treat
 * everything from BEGIN to EOF as ours. Rationale — that state can only be produced by a
 * crash or a partial hand-edit of a block we wrote, and leaving orphaned `127.0.0.1` lines
 * behind is worse than dropping text that was almost certainly ours to begin with. A BEGIN
 * with a matching END never consumes anything past that END.
 */
function findBlockRanges(lines: Line[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || !isMarker(line, HOSTS_BEGIN)) {
      i += 1;
      continue;
    }
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (candidate && isMarker(candidate, HOSTS_END)) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      ranges.push([i, lines.length - 1]);
      return ranges;
    }
    ranges.push([i, end]);
    i = end + 1;
  }
  return ranges;
}

/** Trims, drops blanks, drops anything `isValidHostname` rejects, dedupes, keeps input order. */
function acceptableHostnames(hostnames: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of hostnames) {
    const host = typeof raw === "string" ? raw.trim() : "";
    if (!isValidHostname(host) || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure transforms
// ---------------------------------------------------------------------------

/**
 * The complete managed block, markers included, always ending with a newline.
 *
 * Invalid hostnames are dropped rather than emitted. Callers are expected to have validated
 * already; this is the last line of defence, because a hostname containing a newline or a '#'
 * would otherwise let a caller inject arbitrary lines into /etc/hosts.
 */
export function renderBlock(hostnames: string[]): string {
  const lines: string[] = [HOSTS_BEGIN, MANAGED_NOTE];
  for (const host of acceptableHostnames(hostnames)) {
    lines.push(`${IPV4_LOOPBACK}\t${host}`);
    lines.push(`${IPV6_LOOPBACK}\t${host}`);
  }
  lines.push(HOSTS_END);
  return `${lines.join("\n")}\n`;
}

/**
 * Hostnames currently declared inside the managed block(s), in order, deduped.
 * Returns `[]` when no block is present. Duplicate blocks are merged.
 */
export function parseBlock(content: string): string[] {
  const lines = splitLines(content);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [start, end] of findBlockRanges(lines)) {
    for (let i = start + 1; i <= end; i += 1) {
      const line = lines[i];
      if (!line) continue;
      const text = line.text.trim();
      // Skips blanks, our note, the END marker, and any comment a user added inside.
      if (text === "" || text.startsWith("#")) continue;
      // A hosts entry is "<ip> <name> [more names...]".
      for (const host of text.split(/\s+/).slice(1)) {
        if (host === "" || seen.has(host)) continue;
        seen.add(host);
        out.push(host);
      }
    }
  }
  return out;
}

/**
 * Joins `prefix` + block + `suffix`, separating the block from any neighbouring content with
 * exactly one blank line. `applyBlock` strips exactly one blank line on each side of a block
 * before calling this, which is what makes the whole operation idempotent.
 */
function spliceBlock(prefix: string, suffix: string, block: string): string {
  let out = prefix;
  if (out !== "") {
    if (!out.endsWith("\n")) out += "\n";
    out += "\n";
  }
  out += block;
  if (suffix !== "") out += `\n${suffix}`;
  return out;
}

/**
 * Rewrites `content` so the managed block declares exactly `hostnames`.
 *
 * Pure and idempotent: `applyBlock(applyBlock(c, h), h) === applyBlock(c, h)`.
 * An empty `hostnames` array removes the block entirely. Duplicate blocks collapse into one,
 * kept at the position of the first. Content between and around blocks is preserved.
 */
export function applyBlock(content: string, hostnames: string[]): string {
  const lines = splitLines(content);
  const ranges = findBlockRanges(lines);
  const removing = hostnames.length === 0;

  if (ranges.length === 0) {
    if (removing) return content;
    return spliceBlock(content, "", renderBlock(hostnames));
  }

  const drop = new Array<boolean>(lines.length).fill(false);
  for (const [start, end] of ranges) {
    for (let i = start; i <= end; i += 1) drop[i] = true;
    // Swallow one blank line on each side: precisely the separators `spliceBlock` adds, so a
    // second application reproduces the first byte for byte instead of drifting.
    const before = lines[start - 1];
    if (start > 0 && before && isBlank(before)) drop[start - 1] = true;
    const after = lines[end + 1];
    if (after && isBlank(after)) drop[end + 1] = true;
  }

  const firstStart = ranges[0]![0];
  let prefix = "";
  let suffix = "";
  for (let i = 0; i < lines.length; i += 1) {
    if (drop[i]) continue;
    const line = lines[i]!;
    if (i < firstStart) prefix += line.text + line.eol;
    else suffix += line.text + line.eol;
  }

  if (removing) return prefix + suffix;
  return spliceBlock(prefix, suffix, renderBlock(hostnames));
}

/**
 * Defence in depth for the root helper: the last check a string passes before it is written
 * into /etc/hosts. Assumes the caller is compromised, so it is strict on purpose — lowercase
 * DNS labels only, no whitespace, no '#', nothing reserved.
 */
export function isValidHostname(host: string): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  if (host.length > MAX_HOSTNAME_LENGTH) return false;
  // Redundant with the regex below, but stated explicitly: these are the injection vectors.
  if (/[\s#]/.test(host)) return false;
  if (!HOSTNAME_RE.test(host)) return false;
  if (host.split(".").some((label) => label.length > MAX_LABEL_LENGTH)) return false;
  if ((RESERVED_NAMES as readonly string[]).includes(host.toLowerCase())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Resolved on every call rather than captured at import time. `HOSTS_PATH` is a module
 * constant baked in the first time paths.ts loads, so a test file that (directly or
 * transitively) imports another module before setting `LA_HOSTS_PATH` would otherwise end up
 * pointed at the real /etc/hosts. Late binding makes that mistake impossible.
 */
function hostsPath(): string {
  return process.env.LA_HOSTS_PATH ?? HOSTS_PATH;
}

/** Current hosts file content, or "" when the file does not exist. */
export async function readHosts(): Promise<string> {
  const file = Bun.file(hostsPath());
  if (!(await file.exists())) return "";
  return await file.text();
}

/**
 * Atomic replace. The temp file lives in the *same* directory as the target so `rename()`
 * stays inside one filesystem and is therefore atomic: a crash mid-write leaves /etc/hosts
 * as either the old file or the new one, never truncated.
 */
export async function writeHosts(content: string): Promise<void> {
  const target = hostsPath();
  const tmp = join(dirname(target), `.${basename(target)}.localhost-aliases.${process.pid}.tmp`);
  try {
    await Bun.write(tmp, content);
    await chmod(tmp, 0o644); // /etc/hosts must stay world-readable regardless of umask.
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Runs a fixed command, swallowing every failure mode into `false`. */
async function runQuiet(command: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Flushes the macOS DNS caches. Never throws — returns false when either step fails, which is
 * the normal outcome when not running as root (`killall -HUP mDNSResponder` needs privileges).
 * Both commands are attempted even if the first fails, and both are absolute paths: this runs
 * as root, so nothing here may be resolved through $PATH.
 */
export async function flushDns(): Promise<boolean> {
  const flushed = await runQuiet([DSCACHEUTIL, "-flushcache"]);
  const notified = await runQuiet([KILLALL, "-HUP", "mDNSResponder"]);
  return flushed && notified;
}
