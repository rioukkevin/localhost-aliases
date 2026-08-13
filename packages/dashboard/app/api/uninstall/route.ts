import { problem, route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

/**
 * Uninstall removes lo0 aliases, the /etc/hosts block and the trusted certificate —
 * all privileged. The dashboard runs unprivileged and must not pretend otherwise.
 */
export const POST = route(async () =>
  problem(
    501,
    "Uninstall runs from the menu bar app or `make uninstall`: it needs one admin prompt, and the dashboard never runs privileged commands.",
  ),
);
