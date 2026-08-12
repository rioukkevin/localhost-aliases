/**
 * The only place in the system that writes `/etc/hosts`.
 *
 * All of the risky string work lives in core (`applyBlock` is pure and heavily unit-tested);
 * this module is the thin I/O shell around it: read, transform, compare, write, flush.
 */
import { applyBlock, flushDns, parseBlock, readHosts, writeHosts } from "@localhost-aliases/core";

export interface HostsResult {
  changed: boolean;
  dnsFlushed: boolean;
  hostnames: string[];
}

/**
 * Sorted, deduped hostnames.
 *
 * Sorting makes the rendered block a function of the *set* of aliases rather than of the
 * order they happen to sit in config.json, so reordering aliases in the dashboard no longer
 * rewrites /etc/hosts and flushes DNS for nothing.
 */
export function managedHostnames(hosts: string[]): string[] {
  return [...new Set(hosts.map((host) => host.toLowerCase()))].sort();
}

/**
 * Reconciles the managed block with `hosts`. DNS is flushed only when the file actually
 * changed on disk — a no-op apply must stay a no-op, because `killall -HUP mDNSResponder`
 * briefly disturbs name resolution for the whole machine.
 */
export async function reconcileHosts(hosts: string[]): Promise<HostsResult> {
  const hostnames = managedHostnames(hosts);
  const current = await readHosts();
  const next = applyBlock(current, hostnames);

  if (next === current) return { changed: false, dnsFlushed: false, hostnames };

  await writeHosts(next);
  const dnsFlushed = await flushDns();
  return { changed: true, dnsFlushed, hostnames };
}

/** Hostnames currently declared in the managed block, straight from disk (for /status). */
export async function readManagedHosts(): Promise<string[]> {
  return parseBlock(await readHosts());
}
