/**
 * Pure transforms over the managed /etc/hosts block. No file I/O lives here: the
 * privileged script does the writing, this module only produces the bytes.
 *
 * Everything outside HOSTS_BEGIN/HOSTS_END is preserved byte for byte.
 */
import { HOSTS_BEGIN, HOSTS_END } from "./types.ts";
import { isValidIpv4 } from "./ips.ts";

export interface HostsEntry {
  ip: string;
  hostname: string;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Defence in depth for the privileged script: anything false here must never be
 * written to /etc/hosts, whatever the config claims.
 */
export function isValidHostname(host: string): boolean {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  if (/[\s#]/.test(host)) return false;
  return host.split(".").every((l) => l.length >= 1 && l.length <= 63 && LABEL_RE.test(l));
}

function assertEntries(entries: readonly HostsEntry[]): void {
  for (const e of entries) {
    if (!isValidIpv4(e.ip)) throw new Error(`Refusing to write hosts entry: invalid IP "${e.ip}".`);
    if (!isValidHostname(e.hostname)) {
      throw new Error(`Refusing to write hosts entry: invalid hostname "${e.hostname}".`);
    }
  }
}

/** The managed block, markers included, always ending in a line break. */
export function renderBlock(entries: readonly HostsEntry[], eol = "\n"): string {
  assertEntries(entries);
  const lines = [HOSTS_BEGIN, ...entries.map((e) => `${e.ip}\t${e.hostname}`), HOSTS_END];
  return lines.join(eol) + eol;
}

interface BlockRange {
  /** Offset of the BEGIN marker line. */
  start: number;
  /** Offset just past the END marker's line break (or EOF when unterminated). */
  end: number;
  terminated: boolean;
}

function findBlocks(content: string): BlockRange[] {
  const blocks: BlockRange[] = [];
  let offset = 0;
  let open: number | null = null;

  while (offset <= content.length) {
    const nl = content.indexOf("\n", offset);
    const lineEnd = nl === -1 ? content.length : nl + 1;
    const line = content.slice(offset, nl === -1 ? content.length : nl).trim();

    if (open === null && line === HOSTS_BEGIN) {
      open = offset;
    } else if (open !== null && line === HOSTS_END) {
      blocks.push({ start: open, end: lineEnd, terminated: true });
      open = null;
    }

    if (nl === -1) break;
    offset = lineEnd;
  }
  // An unterminated block runs to EOF; treating it as ours is what makes a
  // half-written /etc/hosts recoverable instead of permanently duplicated.
  if (open !== null) blocks.push({ start: open, end: content.length, terminated: false });
  return blocks;
}

/** Entries of the first managed block. Empty when there is no block. */
export function parseBlock(content: string): HostsEntry[] {
  const [block] = findBlocks(content);
  if (!block) return [];
  const body = content.slice(block.start, block.end).split(/\r?\n/);
  const entries: HostsEntry[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [ip, hostname] = line.split(/\s+/);
    if (ip && hostname && isValidIpv4(ip) && isValidHostname(hostname)) entries.push({ ip, hostname });
  }
  return entries;
}

function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Replace the managed block with `entries`, or remove it when `entries` is empty.
 * Idempotent, and duplicate blocks collapse into one.
 */
export function applyBlock(content: string, entries: readonly HostsEntry[]): string {
  assertEntries(entries);
  const eol = detectEol(content);
  const block = entries.length > 0 ? renderBlock(entries, eol) : "";
  const blocks = findBlocks(content);

  if (blocks.length === 0) {
    if (block === "") return content;
    if (content === "") return block;
    const separator = content.endsWith("\n") ? "" : eol;
    return content + separator + block;
  }

  let out = "";
  let cursor = 0;
  blocks.forEach((range, i) => {
    out += content.slice(cursor, range.start);
    if (i === 0) out += block;
    cursor = range.end;
  });
  out += content.slice(cursor);
  return out;
}
