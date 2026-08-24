/**
 * Automatic apply, as the user sees it.
 *
 * The rule these tests exist to defend is the one the whole product's credibility rests
 * on: nothing may say a name is live before the apply actually succeeded. So the row
 * chip, the cable, the indicator gauge and the banner are all asserted against states
 * where the alias is saved but the machine has not been touched.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AliasView, Config, SystemState } from "@localhost-aliases/core/types";
import { AliasRow } from "../components/aliases/AliasRow.tsx";
import { aliasApply, applyChip, isLive } from "../components/aliases/alias-apply.ts";
import { driftCopy } from "../components/DriftBanner.tsx";
import { AutoApplySection, autoApplyExplainer } from "../components/settings/AutoApply.tsx";
import { SettingsDrawer } from "../components/shell/SettingsDrawer.tsx";
import { StatusIndicator } from "../components/shell/StatusIndicator.tsx";
import { ToastProvider } from "../components/ui/Toast.tsx";
import {
  AUTO_APPLY_IDLE,
  autoApplyEnabled,
  readApply,
  readAutoApply,
  type AutoApply,
} from "../components/shell/auto-apply-read.ts";
import type { StatusState } from "../lib/client/status-store.ts";

const ALIAS: AliasView = {
  id: "id-shop",
  name: "shop",
  port: 3000,
  ip: "127.0.0.4",
  projectPath: null,
  description: null,
  enabled: true,
  reserved: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  hostname: "shop.test",
  url: "http://shop.test",
  // The dev server IS answering — which says nothing at all about the alias.
  status: "up",
};

const ROUTE = { ip: "127.0.0.4", listenPort: 80, targetPort: 3000, hostname: "shop.test" };

const APPLIED: SystemState = {
  loopbackIps: ["127.0.0.4"],
  managedHosts: ["shop.test"],
  forwarder: { pid: 1, startedAt: "2026-01-01T00:00:00.000Z", routes: [ROUTE], failures: [] },
  applied: true,
  drift: [],
};

const REBOOTED: SystemState = {
  // /etc/hosts survives a reboot; the lo0 addresses do not.
  loopbackIps: [],
  managedHosts: ["shop.test"],
  forwarder: null,
  applied: false,
  drift: ["127.0.0.4 is missing from lo0"],
};

function statusState(over: Partial<StatusState> = {}): StatusState {
  return {
    loaded: true,
    reachable: true,
    error: null,
    config: null,
    aliases: [],
    system: null,
    sync: null,
    trayAlive: true,
    autoApply: null,
    busy: false,
    updatedAt: 1,
    ...over,
  };
}

function row(apply: Parameters<typeof applyChip>[0]) {
  return renderToStaticMarkup(
    <AliasRow
      alias={ALIAS}
      aliases={[ALIAS]}
      tld="local"
      editing={false}
      apply={apply}
      onEdit={() => {}}
      onSave={async () => {}}
      onDelete={async () => {}}
      onDetach={async () => {}}
    />,
  );
}

describe("reading the auto-apply state off the shared snapshot", () => {
  test("nothing on the snapshot reads as idle, which is today's manual UI", () => {
    expect(readAutoApply(statusState())).toEqual(AUTO_APPLY_IDLE);
    expect(readApply(AUTO_APPLY_IDLE)).toBeNull();
  });

  test("asserts nothing before the first poll has answered", () => {
    const state = statusState({ loaded: false });
    (state as { autoApply?: unknown }).autoApply = { phase: "deferred" };
    expect(readAutoApply(state).phase).toBe("idle");
  });

  test("accepts the phase at the snapshot root or inside the sync report", () => {
    const root = statusState();
    (root as { autoApply?: unknown }).autoApply = { phase: "prompting" };
    expect(readAutoApply(root).phase).toBe("prompting");

    const nested = statusState({ sync: { autoApply: "scheduled" } as never });
    expect(readAutoApply(nested).phase).toBe("scheduled");
  });

  test("reads the service layer's AutoApplyStatus verbatim", () => {
    // The exact shape lib/auto-apply.ts publishes on the polled snapshot.
    const state = statusState();
    (state as { autoApply?: unknown }).autoApply = {
      state: "deferred",
      enabled: true,
      requestId: "req-1",
      scheduledInMs: null,
      dirty: false,
      error: null,
      reason: "You dismissed the administrator prompt.",
    };
    const auto = readAutoApply(state);
    expect(auto.phase).toBe("deferred");
    expect(auto.reason).toBe("You dismissed the administrator prompt.");
    expect(readApply(auto)!.retryable).toBe(true);
  });

  test("an unrecognised phase never invents a state", () => {
    const state = statusState();
    (state as { autoApply?: unknown }).autoApply = { phase: "exploding" };
    expect(readAutoApply(state).phase).toBe("idle");
  });

  test("the error is the real one, and only failure carries it", () => {
    const failed = statusState();
    (failed as { autoApply?: unknown }).autoApply = {
      phase: "failed",
      error: "ifconfig: permission denied",
    };
    expect(readAutoApply(failed).error).toBe("ifconfig: permission denied");
    expect(readApply(readAutoApply(failed))!.note).toBe("ifconfig: permission denied");

    const prompting = statusState();
    (prompting as { autoApply?: unknown }).autoApply = { phase: "prompting", error: "stale" };
    expect(readAutoApply(prompting).error).toBeNull();
  });

  test("only deferred and failed offer a retry — nothing re-prompts on its own", () => {
    const retryable = (phase: AutoApply["phase"]) =>
      readApply({ phase, error: null, reason: null })?.retryable ?? null;
    expect(retryable("scheduled")).toBe(false);
    expect(retryable("prompting")).toBe(false);
    expect(retryable("deferred")).toBe(true);
    expect(retryable("failed")).toBe(true);
  });

  test("every non-idle reading says in words what is happening", () => {
    expect(readApply({ phase: "scheduled", error: null, reason: null })!.note).toContain("in a moment");
    expect(readApply({ phase: "prompting", error: null, reason: null })!.note).toContain("your password");
    expect(readApply({ phase: "deferred", error: null, reason: null })!.note).toContain("dismissed the prompt");
  });

  test("the setting defaults to on, including for a config written before it existed", () => {
    expect(autoApplyEnabled(null)).toBe(true);
    expect(autoApplyEnabled({ tld: "test" } as Config)).toBe(true);
    expect(autoApplyEnabled({ autoApply: false } as Config)).toBe(false);
    expect(autoApplyEnabled({ autoApply: true } as Config)).toBe(true);
  });
});

describe("whether a row may call itself live", () => {
  test("live only when all three legs of the path are really there", () => {
    expect(aliasApply(ALIAS, APPLIED)).toBe("live");
    expect(aliasApply(ALIAS, { ...APPLIED, managedHosts: [] })).toBe("unapplied");
    expect(aliasApply(ALIAS, { ...APPLIED, loopbackIps: [] })).toBe("unapplied");
    // The name resolves, but nothing is bound to it: not live.
    expect(aliasApply(ALIAS, { ...APPLIED, forwarder: null })).toBe("unapplied");
    expect(
      aliasApply(ALIAS, {
        ...APPLIED,
        forwarder: {
          pid: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          routes: [ROUTE],
          failures: [{ route: ROUTE, error: "address already in use" }],
        },
      }),
    ).toBe("unapplied");
  });

  test("a dev server answering on the port never makes an unapplied name live", () => {
    expect(ALIAS.status).toBe("up");
    expect(isLive(aliasApply(ALIAS, REBOOTED))).toBe(false);
  });

  test("says nothing before the machine has answered", () => {
    expect(aliasApply(ALIAS, null)).toBe("unknown");
    expect(applyChip("unknown")).toBeNull();
    expect(applyChip("live")).toBeNull();
  });

  test("the optimistic row says it is being saved, not that it is live", () => {
    const optimistic = { ...ALIAS, id: "pending-shop-1" };
    expect(aliasApply(optimistic, APPLIED)).toBe("saving");
    expect(isLive("saving")).toBe(false);
  });

  test("a saved-but-not-live row explains itself with the auto-apply phase", () => {
    const at = (phase: AutoApply["phase"]) => aliasApply(ALIAS, REBOOTED, { phase, error: null, reason: null });
    expect(at("scheduled")).toBe("scheduled");
    expect(at("prompting")).toBe("prompting");
    expect(at("deferred")).toBe("deferred");
    expect(at("failed")).toBe("failed");
    // Auto-apply off, or the menu-bar app down: no queue, so no phase to report.
    expect(at("idle")).toBe("unapplied");
  });

  test("an applied row is untouched by whatever the queue is doing elsewhere", () => {
    expect(aliasApply(ALIAS, APPLIED, { phase: "prompting", error: null, reason: null })).toBe("live");
  });
});

describe("the alias row's own words", () => {
  test("a live row carries no apply chip and its cable drifts", () => {
    const html = row("live");
    expect(html).not.toContain('data-testid="alias-apply"');
    expect(html).toContain("cable-live");
  });

  test("saved and waiting for the prompt: says so, and the cable does not drift", () => {
    const html = row("prompting");
    expect(html).toContain('data-apply="prompting"');
    expect(html).toContain("Approve the admin prompt");
    expect(html).toContain("Saved");
    expect(html).not.toContain("cable-live");
  });

  test("a dismissed prompt leaves the row saying it is not live", () => {
    const html = row("deferred");
    expect(html).toContain("not live");
    expect(html).toContain("does not resolve yet");
    expect(html).not.toContain("cable-live");
  });

  test("a failed apply never leaves the row looking live", () => {
    const html = row("failed");
    expect(html).toContain("not live");
    expect(html).not.toContain("cable-live");
  });

  test("the row is still a whole row: name, port and every action", () => {
    const html = row("deferred");
    expect(html).toContain("shop");
    expect(html).toContain("3000");
    expect(html).toContain("Edit shop.test");
    expect(html).toContain("Delete shop.test");
  });
});

describe("the drift banner, which stays the whole path when nothing is automatic", () => {
  test("idle is byte-for-byte the banner the app has always had", () => {
    expect(driftCopy("idle", false)).toMatchObject({
      testId: "banner-drift",
      tone: "warn",
      title: "Live state has drifted",
      action: "Re-apply now",
    });
    expect(driftCopy("idle", true).title).toBe("Nothing is applied on this Mac yet");
    expect(driftCopy("idle", true).action).toBe("Re-apply now");
  });

  test("while a prompt is on its way it explains, and offers no second prompt", () => {
    for (const phase of ["scheduled", "prompting"] as const) {
      const copy = driftCopy(phase, false);
      expect(copy.testId).toBe("banner-applying");
      expect(copy.tone).toBe("info");
      expect(copy.action).toBeNull();
    }
    expect(driftCopy("scheduled", false).body).toContain("one password");
    expect(driftCopy("prompting", false).body).toContain("Approve it");
  });

  test("a dismissed prompt is the one state that must offer a way back", () => {
    const copy = driftCopy("deferred", false);
    expect(copy.title).toBe("You dismissed the admin prompt");
    expect(copy.action).toBe("Try again");
    expect(copy.body).toContain("nothing on this Mac has changed");
  });

  test("a failure is loud, and never claims anything was changed", () => {
    const copy = driftCopy("failed", false);
    expect(copy.tone).toBe("danger");
    expect(copy.action).toBe("Try again");
    expect(copy.body).toContain("nothing on this Mac has changed");
  });
});

describe("the settings switch", () => {
  const html = renderToStaticMarkup(
    <ToastProvider>
      <AutoApplySection />
    </ToastProvider>,
  );

  test("is a real switch, on by default, carrying the spec's own explanation", () => {
    expect(html).toContain('data-testid="autoapply-toggle"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Adding or removing an alias asks for your password straight away.");
    expect(html).toContain("Turn this off if you would rather batch changes and apply them");
  });

  test("says what turning it off does — today's manual behaviour, in words", () => {
    expect(autoApplyExplainer(false)).toContain("Nothing will ask for your password on its own");
    expect(autoApplyExplainer(false)).toContain("does not resolve until you press Re-apply now");
    expect(autoApplyExplainer(true)).toContain("still cost one password");
    // The panel shows whichever of the two matches the saved setting.
    expect(html).toContain(autoApplyExplainer(true));
  });

  test("the settings drawer carries it", () => {
    const drawer = renderToStaticMarkup(
      <ToastProvider>
        <SettingsDrawer open onClose={() => {}} />
      </ToastProvider>,
    );
    expect(drawer).toContain('data-testid="autoapply-panel"');
    expect(drawer).toContain('data-testid="autoapply-toggle"');
    // The manual path is still right there, in the same column.
    expect(drawer).toContain('data-testid="status-reapply"');
  });
});

describe("the bottom-right indicator", () => {
  test("grows no third lamp while nothing is being applied", () => {
    const html = renderToStaticMarkup(<StatusIndicator />);
    expect(html).toContain('data-testid="status-indicator"');
    expect(html).toContain("tray");
    expect(html).not.toContain('data-testid="apply-gauge"');
  });
});
