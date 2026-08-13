/** Stderr logging. The forwarder runs as root under the tray, which captures stderr. */

export type Logger = (message: string) => void;

const quiet = process.env.LA_FORWARDER_QUIET === "1";

export const stderrLog: Logger = (message) => {
  if (quiet) return;
  process.stderr.write(`[forwarder ${new Date().toISOString()}] ${message}\n`);
};

export const silentLog: Logger = () => {};
