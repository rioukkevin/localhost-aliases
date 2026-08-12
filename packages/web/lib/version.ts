import pkg from "../package.json";

/** Reported by `GET /api/status`; single source of truth is the package manifest. */
export const VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";
