/**
 * Turns a settings draft into "here is exactly what applying this will do".
 *
 * Kept pure and framework-free so the wording of a consequence lives in one
 * place: the pending-changes bar, the confirmation dialog and the after-the-fact
 * receipt all render the same list.
 *
 * The TLD rules mirror core's `validateTld` for the same reason
 * `lib/client/validation.ts` mirrors `validateName` — core is a Bun-only barrel
 * and cannot be bundled for the browser. The server stays the authority.
 */
import type { AliasView } from "@localhost-aliases/core";
import type { Settings } from "./api.ts";

export interface Draft {
  tld: string;
  httpPort: string;
  httpsPort: string;
  https: boolean;
}

export type DraftField = keyof Draft;

export interface Rewrite {
  from: string;
  to: string;
}

export interface SettingChange {
  key: "tld" | "httpPort" | "httpsPort" | "https";
  label: string;
  from: string;
  to: string;
  /** Plain-language consequences, shown before the change is applied. */
  impact: string[];
  rewrites?: Rewrite[];
  /** `warn` for anything that breaks an existing URL. */
  tone: "warn" | "info";
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** trim, lowercase, strip a leading dot and trailing dots — same as core. */
export function normalizeTld(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^\.+/, "");
}

export function tldError(raw: string): string | null {
  const value = normalizeTld(raw);
  if (value.length === 0) return "A TLD is required.";
  if (value.length > 253) return "Too long — at most 253 characters.";
  for (const label of value.split(".")) {
    if (label.length === 0) return "Contains an empty label — check the dots.";
    if (label.length > 63) return `"${label}" is longer than 63 characters.`;
    if (!LABEL_RE.test(label)) {
      return "Use only a-z, 0-9 and hyphens; a label cannot start or end with a hyphen.";
    }
  }
  if (/^[0-9]+$/.test(value.split(".").at(-1) ?? "")) {
    return "A numeric TLD would be ambiguous with an IP address.";
  }
  return null;
}

export function portFieldError(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return "Required.";
  if (!/^\d+$/.test(value)) return "Ports are digits only.";
  const port = Number(value);
  if (port < 1 || port > 65535) return "Must be between 1 and 65535.";
  return null;
}

export function draftFrom(settings: Settings): Draft {
  return {
    tld: settings.tld,
    httpPort: String(settings.httpPort),
    httpsPort: String(settings.httpsPort),
    https: settings.https,
  };
}

export function draftErrors(draft: Draft): Partial<Record<DraftField, string>> {
  const errors: Partial<Record<DraftField, string>> = {};
  const tld = tldError(draft.tld);
  if (tld) errors.tld = tld;
  const http = portFieldError(draft.httpPort);
  if (http) errors.httpPort = http;
  const https = portFieldError(draft.httpsPort);
  if (https) errors.httpsPort = https;
  return errors;
}

/** Only the fields that actually differ, so a PATCH never rewrites untouched settings. */
export function patchFrom(draft: Draft, saved: Settings): Partial<Settings> {
  const patch: Partial<Settings> = {};
  if (normalizeTld(draft.tld) !== saved.tld) patch.tld = normalizeTld(draft.tld);
  if (Number(draft.httpPort) !== saved.httpPort) patch.httpPort = Number(draft.httpPort);
  if (Number(draft.httpsPort) !== saved.httpsPort) patch.httpsPort = Number(draft.httpsPort);
  if (draft.https !== saved.https) patch.https = draft.https;
  return patch;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function changesFor(draft: Draft, saved: Settings, aliases: AliasView[]): SettingChange[] {
  const changes: SettingChange[] = [];
  const nextTld = normalizeTld(draft.tld);

  if (nextTld !== saved.tld && tldError(draft.tld) === null) {
    changes.push({
      key: "tld",
      label: "Hostname suffix",
      from: `.${saved.tld}`,
      to: `.${nextTld}`,
      tone: "warn",
      impact: [
        aliases.length === 0
          ? "No aliases exist yet, so only new ones are affected."
          : `${plural(aliases.length, "hostname is", "hostnames are")} rewritten in the managed /etc/hosts block and re-registered with the proxy.`,
        "Every URL that used the old suffix stops resolving — bookmarks, .env files, anything an agent wrote down.",
        "The DNS cache is flushed, so the new names work immediately.",
      ],
      rewrites: aliases.map((alias) => ({
        from: alias.hostname,
        to: nextTld ? `${alias.name}.${nextTld}` : alias.name,
      })),
    });
  }

  const nextHttp = Number(draft.httpPort);
  if (nextHttp !== saved.httpPort && portFieldError(draft.httpPort) === null) {
    changes.push({
      key: "httpPort",
      label: "HTTP port",
      from: `:${saved.httpPort}`,
      to: `:${nextHttp}`,
      tone: "warn",
      impact: [
        `The helper rebinds its plain-HTTP listener to :${nextHttp}; requests to :${saved.httpPort} stop being answered.`,
        nextHttp === 80
          ? "Alias URLs go back to http://name — no port to type."
          : `Alias URLs become http://name:${nextHttp}; the port has to be typed in the browser.`,
        "If another process already holds that port the helper refuses the change and keeps the current one.",
      ],
    });
  }

  const nextHttps = Number(draft.httpsPort);
  if (nextHttps !== saved.httpsPort && portFieldError(draft.httpsPort) === null) {
    changes.push({
      key: "httpsPort",
      label: "HTTPS port",
      from: `:${saved.httpsPort}`,
      to: `:${nextHttps}`,
      tone: draft.https ? "warn" : "info",
      impact: draft.https
        ? [
            `The helper rebinds its TLS listener to :${nextHttps}.`,
            nextHttps === 443
              ? "Alias URLs go back to https://name — no port to type."
              : `Alias URLs become https://name:${nextHttps}.`,
          ]
        : ["HTTPS is off, so this only takes effect the next time you turn it on."],
    });
  }

  if (draft.https !== saved.https) {
    changes.push({
      key: "https",
      label: "HTTPS",
      from: saved.https ? "on" : "off",
      to: draft.https ? "on" : "off",
      tone: "warn",
      impact: draft.https
        ? [
            "A local certificate authority is created in the config directory, if it does not exist yet.",
            `One certificate covering every alias hostname is issued and handed to the helper, which binds :${nextHttps || saved.httpsPort}.`,
            "Browsers keep warning until that CA is trusted in the System keychain — the command to do it is below.",
            "Alias URLs switch to https://.",
          ]
        : [
            "The helper stops serving TLS; alias URLs go back to http://.",
            "The local CA and its certificates stay on disk, and stay trusted if you already trusted them.",
          ],
    });
  }

  return changes;
}
