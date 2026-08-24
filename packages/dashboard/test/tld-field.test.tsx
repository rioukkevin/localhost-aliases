/**
 * The settings TLD field: what it offers, and what it refuses inline.
 *
 * The point of the inline message is that it is the SAME sentence the server would answer
 * with — a field that says "not allowed" while the API says "5 seconds of mDNS" teaches the
 * user nothing and sends them to the next broken suffix.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_TLD,
  HSTS_PRELOADED_TLDS,
  SAFE_TLDS,
  blockedTldReason,
} from "@localhost-aliases/core/types";
import { validateTld } from "../lib/client/validate.ts";
import { refreshStatus, resetStatus } from "../lib/client/status-store.ts";
import { AliasDefaults } from "../components/settings/AliasDefaults.tsx";
import { ToastProvider } from "../components/ui/Toast.tsx";

describe("validateTld", () => {
  test("accepts the suffixes the product offers", () => {
    for (const tld of SAFE_TLDS) expect(validateTld(tld)).toBeNull();
    expect(validateTld("test")).toBeNull();
  });

  test("refuses local, naming mDNS and the 5 seconds", () => {
    const message = validateTld("local");
    expect(message).toContain("mDNS");
    expect(message).toContain("5 seconds");
  });

  test("refuses the HSTS-preloaded TLDs, naming https", () => {
    for (const tld of ["dev", "app", "page", "foo"]) {
      expect(validateTld(tld)).toContain("HSTS");
      expect(validateTld(tld)).toContain("https");
    }
  });

  test("local, dev and localhost each get their own sentence", () => {
    const messages = new Set([validateTld("local"), validateTld("dev"), validateTld("localhost")]);
    expect(messages.size).toBe(3);
  });

  test("says exactly what core says, for every blocked suffix", () => {
    for (const tld of ["local", "localhost", ...HSTS_PRELOADED_TLDS]) {
      expect(validateTld(tld)).toBe(blockedTldReason(tld));
    }
  });

  test("shape problems are still caught before the blocklist", () => {
    expect(validateTld("")).toMatch(/required/);
    expect(validateTld(".test")).toMatch(/leading dot/);
    expect(validateTld("TEST")).toMatch(/lowercase/);
  });
});

// --- the rendered field -----------------------------------------------------

const payload = {
  config: { version: 2, tld: DEFAULT_TLD, dashboardPort: 7788, https: false, autoApply: true, aliases: [] },
  aliases: [],
  system: { loopbackIps: [], managedHosts: [], forwarder: null, applied: true, drift: [] },
  sync: { applied: true, needsPrompt: false, drift: [], privileged: [], unprivileged: [], intent: {} },
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetStatus();
});

async function renderField(): Promise<string> {
  globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(Response.json(payload))) as typeof fetch;
  await refreshStatus();
  return renderToStaticMarkup(
    <ToastProvider>
      <AliasDefaults />
    </ToastProvider>,
  );
}

describe("the settings TLD field", () => {
  test("offers every safe suffix as a one-click option", async () => {
    const html = await renderField();
    for (const tld of SAFE_TLDS) expect(html).toContain(`.${tld}`);
  });

  test("never offers .local, nor any HSTS-preloaded suffix, as a choice", async () => {
    const html = await renderField();
    const options = html.slice(html.indexOf('data-testid="tld-options"'));
    expect(options).not.toContain(">.local<");
    for (const tld of HSTS_PRELOADED_TLDS) expect(options).not.toContain(`>.${tld}<`);
  });

  test("the default is the first option offered", async () => {
    const html = await renderField();
    const options = html.slice(html.indexOf('data-testid="tld-options"'));
    const offered = [...options.matchAll(/>\.([a-z0-9.-]+)</g)].map((m) => m[1]);
    expect(offered).toEqual([...SAFE_TLDS]);
    expect(offered[0]).toBe(DEFAULT_TLD);
  });
});
