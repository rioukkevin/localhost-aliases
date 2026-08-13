/**
 * Loopback address allocation over 127.0.0.2 … 127.0.0.254.
 * 127.0.0.1 is the real loopback and is never handed out.
 */
import { IP_POOL_END, IP_POOL_START, IP_PREFIX } from "./types.ts";

export const POOL_SIZE = IP_POOL_END - IP_POOL_START + 1;
export const FIRST_POOL_IP = `${IP_PREFIX}${IP_POOL_START}`;
export const LAST_POOL_IP = `${IP_PREFIX}${IP_POOL_END}`;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip);
  if (!m) return false;
  return m.slice(1).every((part) => part === String(Number(part)) && Number(part) <= 255);
}

export function isPoolIp(ip: string): boolean {
  if (!isValidIpv4(ip) || !ip.startsWith(IP_PREFIX)) return false;
  const last = Number(ip.slice(IP_PREFIX.length));
  return last >= IP_POOL_START && last <= IP_POOL_END;
}

/** Every address in the pool, lowest first. */
export function poolIps(): string[] {
  const out: string[] = [];
  for (let i = IP_POOL_START; i <= IP_POOL_END; i++) out.push(`${IP_PREFIX}${i}`);
  return out;
}

/**
 * The lowest free pool address, so allocations stay dense and predictable.
 * An alias keeps whatever it is given for life; nothing here reshuffles.
 */
export function allocateIp(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (let i = IP_POOL_START; i <= IP_POOL_END; i++) {
    const ip = `${IP_PREFIX}${i}`;
    if (!used.has(ip)) return ip;
  }
  throw new Error(
    `All ${POOL_SIZE} loopback addresses (${FIRST_POOL_IP}–${LAST_POOL_IP}) are in use. ` +
      `Delete an alias to free one.`,
  );
}

/**
 * IPv4 addresses currently on lo0, parsed from `ifconfig lo0` output.
 * Pure string work: the caller runs the command. When the output contains interface
 * headers, only the lo0 block is read; otherwise every `inet` line is taken.
 */
export function parseLoopbackIps(ifconfigOutput: string): string[] {
  const lines = ifconfigOutput.split(/\r?\n/);
  const hasHeaders = lines.some((l) => /^\S+:\s/.test(l));
  const ips: string[] = [];
  let inLo0 = !hasHeaders;

  for (const line of lines) {
    const header = /^(\S+):\s/.exec(line);
    if (header) {
      inLo0 = header[1] === "lo0";
      continue;
    }
    if (!inLo0) continue;
    const inet = /^\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(line);
    if (inet && inet[1] && isValidIpv4(inet[1]) && !ips.includes(inet[1])) ips.push(inet[1]);
  }
  return ips;
}
