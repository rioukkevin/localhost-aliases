/**
 * One structured JSON line per event on stdout. launchd redirects the stream to
 * `logDir()/helper.out.log`, so anything written here is the daemon's audit trail.
 *
 * Never log request bodies or certificate material: this process runs as root and its log
 * is world-readable in the daemon log directory.
 */
export function log(evt: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), evt, ...fields });
  process.stdout.write(`${line}\n`);
}

/** Error objects do not survive JSON.stringify; reduce them to a message. */
export function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
