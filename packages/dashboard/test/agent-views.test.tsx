/**
 * The prompt model, on screen.
 *
 * One admin prompt exists: the one that starts the root agent. While the agent runs it
 * reconciles /etc/hosts, the lo0 addresses and its own routes from the desired state, so
 * an alias edit costs nothing. These tests hold the UI to that — most of them by asserting
 * what must NOT be on the screen, because stale copy promising a password per change is
 * the specific failure this work exists to remove.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ForwarderStatus, SystemState } from "@localhost-aliases/core/types";
import { StatusDetail } from "../components/shell/StatusDetail.tsx";
import { StatusIndicator } from "../components/shell/StatusIndicator.tsx";
import { LaunchAtLoginSection, readLaunch } from "../components/settings/LaunchAtLogin.tsx";
import { OfflineDetail } from "../components/offline/OfflineDetail.tsx";
import { ToastProvider } from "../components/ui/Toast.tsx";
import { agentRunning, readAction, readAgent, readInstall } from "../components/shell/status-read.ts";
import { resetStatus, type StatusState } from "../lib/client/status-store.ts";
import type { LaunchAtLoginState, OfflineView } from "../lib/client/api.ts";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
  resetStatus();
});

// --- readings ---------------------------------------------------------------

const EMPTY_SYSTEM: SystemState = {
  loopbackIps: [],
  managedHosts: [],
  forwarder: null,
  applied: false,
  drift: [],
};

const forwarder = (routes = 2): ForwarderStatus => ({
  pid: 9182,
  startedAt: "2026-01-01T00:00:00.000Z",
  routes: Array.from({ length: routes }, (_, i) => ({
    ip: `127.0.0.${i + 2}`,
    listenPort: 80,
    targetPort: 3000 + i,
    hostname: `a${i}.test`,
  })),
  failures: [],
});

function state(over: Partial<StatusState> = {}): StatusState {
  return {
    loaded: true,
    reachable: true,
    error: null,
    config: null,
    aliases: [],
    system: EMPTY_SYSTEM,
    sync: null,
    trayAlive: true,
    autoApply: null,
    busy: false,
    updatedAt: 1,
    ...over,
  };
}

describe("readAgent", () => {
  test("before the first read it says checking, never 'not running'", () => {
    const reading = readAgent(state({ loaded: false, system: null }));
    expect(reading.tone).toBe("unknown");
    expect(reading.value).toBe("checking…");
    expect(reading.note).not.toContain("is not running");
  });

  test("a lost dashboard drops to unknown rather than asserting anything", () => {
    const reading = readAgent(state({ reachable: false }));
    expect(reading.tone).toBe("unknown");
    expect(reading.note).toContain("Nothing on your Mac has changed");
    expect(agentRunning(state({ reachable: false, system: { ...EMPTY_SYSTEM, forwarder: forwarder() } }))).toBe(false);
  });

  test("no live forwarder process means the agent is down, and one prompt starts it", () => {
    const reading = readAgent(state());
    expect(reading.tone).toBe("down");
    expect(reading.value).toBe("not running");
    expect(reading.note).toContain("asks for your password once");
    expect(reading.note).toContain("never prompts again");
  });

  test("a live one names the pid, the route count, and promises no more prompts", () => {
    const reading = readAgent(state({ system: { ...EMPTY_SYSTEM, forwarder: forwarder(3) } }));
    expect(reading.tone).toBe("live");
    expect(reading.value).toBe("running");
    expect(reading.note).toContain("pid 9182");
    expect(reading.note).toContain("3 names");
    expect(reading.note).toContain("not be asked for your password again");
    expect(agentRunning(state({ system: { ...EMPTY_SYSTEM, forwarder: forwarder(3) } }))).toBe(true);
  });

  test("one route is singular — the app does not print '1 names'", () => {
    expect(readAgent(state({ system: { ...EMPTY_SYSTEM, forwarder: forwarder(1) } })).note).toContain("1 name.");
  });
});

describe("readInstall, now that drift has an owner", () => {
  test("with the agent up, drift is something being handled, not something to approve", () => {
    const note = readInstall(state({ system: { ...EMPTY_SYSTEM, forwarder: forwarder() } })).note;
    expect(note).toContain("no password needed");
  });

  test("with the agent down, it says what is missing and what starting it does", () => {
    const note = readInstall(state()).note;
    expect(note).toContain("the one admin prompt");
  });
});

// --- the panel --------------------------------------------------------------

/**
 * The button and its sentence are asserted through `readAction` rather than through a
 * render: `useSyncExternalStore` hands a server render the store's EMPTY snapshot, so a
 * rendered assertion about a loaded machine would silently be an assertion about an
 * unloaded one. The render tests below cover exactly what a server render CAN prove.
 */
describe("the one button, and the sentence beside it", () => {
  test("agent down: the button offers the one prompt and names its cost", () => {
    const action = readAction({ agentUp: false, applied: false, retryable: false, inFlight: false });
    expect(action.label).toBe("Start the agent");
    expect(action.aside).toBe("one admin prompt, once — then never again");
    expect(action.primary).toBe(true);
  });

  test("agent up and applied: the button is quiet and promises no password", () => {
    const action = readAction({ agentUp: true, applied: true, retryable: false, inFlight: false });
    expect(action.label).toBe("Re-apply now");
    expect(action.aside).toBe("the agent is up — nothing here asks for a password");
    expect(action.primary).toBe(false);
  });

  test("agent up but drifted: still no password, because the agent owns the fix", () => {
    const action = readAction({ agentUp: true, applied: false, retryable: false, inFlight: false });
    expect(action.aside).not.toContain("prompt");
    expect(action.aside).toContain("nothing here asks for a password");
  });

  test("a dismissed or failed run is the only thing that says 'Try again'", () => {
    for (const agentUp of [false, true]) {
      expect(readAction({ agentUp, applied: false, retryable: true, inFlight: false }).label).toBe("Try again");
    }
  });

  test("while a prompt is genuinely up, it says so and offers no second one", () => {
    expect(readAction({ agentUp: false, applied: false, retryable: false, inFlight: true }).aside).toBe(
      "one prompt is already on its way",
    );
  });

  test("no branch anywhere promises a password per change", () => {
    for (const agentUp of [false, true]) {
      for (const applied of [false, true]) {
        for (const retryable of [false, true]) {
          for (const inFlight of [false, true]) {
            const aside = readAction({ agentUp, applied, retryable, inFlight }).aside;
            expect(aside).not.toContain("each");
            expect(aside).not.toContain("every change");
          }
        }
      }
    }
  });
});

describe("what a cold render is allowed to claim", () => {
  test("the panel names the root agent as its own reading, and claims nothing yet", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <StatusDetail />
      </ToastProvider>,
    );
    expect(html).toContain('data-testid="status-agent"');
    expect(html).toContain("root agent");
    expect(html).toContain("Looking for the root agent");
    expect(html).not.toContain("is not running");
  });

  test("the indicator carries a permanent agent lamp, unknown until asked", () => {
    const html = renderToStaticMarkup(<StatusIndicator />);
    expect(html).toContain('data-testid="agent-gauge"');
    expect(html).toContain("root agent checking…");
    expect(html).not.toContain("root agent not running");
    // Three permanent gauges now, in this order.
    expect(html.indexOf(">tray<")).toBeLessThan(html.indexOf(">agent<"));
    expect(html.indexOf(">agent<")).toBeLessThan(html.indexOf(">state<"));
  });
});

// --- launch at login --------------------------------------------------------

describe("the launch-at-login switch", () => {
  const at = (over: Partial<LaunchAtLoginState>): LaunchAtLoginState => ({
    status: "unknown" as const,
    enabled: null,
    canToggle: null,
    needsSystemSettings: false,
    systemSettingsUrl: null,
    updatedAt: null,
    pending: false,
    requested: null,
    ...over,
  });

  test("unknown is a position of its own: not on, and explicitly not off", () => {
    const reading = readLaunch(at({}));
    expect(reading.checked).toBeNull();
    expect(reading.value).toBe("unknown");
    expect(reading.actionable).toBe(false);
    expect(reading.note).toContain("not a claim that launching at login is off");
  });

  /** Registered but unapproved does not launch anything. A switch showing "on" would lie. */
  test("approval outstanding reads as needing approval, never as on", () => {
    const reading = readLaunch(at({ status: "requiresApproval", enabled: false }));
    expect(reading.checked).toBe(false);
    expect(reading.value).toBe("needs approval");
    expect(reading.note).toContain("System Settings");
    expect(reading.note).toContain("will not start by itself");
  });

  test("each remaining status gets its own sentence", () => {
    expect(readLaunch(at({ status: "enabled", enabled: true })).checked).toBe(true);
    expect(readLaunch(at({ status: "notRegistered", enabled: false })).checked).toBe(false);
    const notFound = readLaunch(at({ status: "notFound", enabled: false, canToggle: false }));
    expect(notFound.actionable).toBe(false);
    expect(notFound.note).toContain("nothing to register");
  });

  test("the cost is stated before the click, not after", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <LaunchAtLoginSection />
      </ToastProvider>,
    );
    expect(html).toContain('data-testid="launch-toggle"');
    expect(html).toContain("One admin prompt per login");
    // The first render has asked nobody anything, so it must show unknown.
    expect(html).toContain('data-testid="launch-unknown-note"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("never as off");
  });

  test("the enabled sentence repeats the cost where the user will read it", () => {
    expect(readLaunch(at({ status: "enabled", enabled: true })).note).toContain(
      "one administrator prompt per login",
    );
  });
});

// --- the offline page -------------------------------------------------------

const OFFLINE: OfflineView = {
  hostname: "shop.test",
  known: true,
  listening: false,
  checkedAt: "2026-01-01T00:00:00.000Z",
  stack: { framework: "Next.js", command: "next dev -p 3000", confidence: "high" },
  alias: {
    id: "id-shop",
    name: "shop",
    hostname: "shop.test",
    url: "http://shop.test",
    targetPort: 3000,
    ip: "127.0.0.4",
    projectPath: "/Users/kevin/code/shop",
    enabled: true,
    reserved: false,
  },
};

const offlineHtml = (
  view: OfflineView | null,
  error: string | null = null,
  agentUp: boolean | null = true,
) => renderToStaticMarkup(<OfflineDetail view={view} error={error} requested="shop.test" agentUp={agentUp} />);

describe("the /offline page", () => {
  test("names the alias, the address and the port nothing answers on", () => {
    const html = offlineHtml(OFFLINE);
    expect(html).toContain("shop.test");
    expect(html).toContain("127.0.0.4");
    expect(html).toContain("127.0.0.1:3000");
    expect(html).toContain("Nothing is accepting connections on");
    expect(html).toContain('data-listening="false"');
  });

  test("prints the exact command for the detected stack", () => {
    const html = offlineHtml(OFFLINE);
    expect(html).toContain('data-testid="offline-framework"');
    expect(html).toContain("Next.js");
    expect(html).toContain("next dev -p 3000");
    expect(html).toContain("starts this project on port 3000");
  });

  test("a low-confidence detection says so instead of pretending", () => {
    const html = offlineHtml({ ...OFFLINE, stack: { ...OFFLINE.stack!, confidence: "low" } });
    expect(html).toContain("inferred from the dependencies");
  });

  test("an unknown stack is stated plainly, with no command anywhere", () => {
    const html = offlineHtml({ ...OFFLINE, stack: null });
    expect(html).toContain("We do not recognise");
    expect(html).toContain("~/code/shop");
    expect(html).not.toContain('data-testid="offline-command"');
    expect(html).not.toContain("next dev");
  });

  test("an alias with no folder says that, rather than blaming detection", () => {
    const html = offlineHtml({
      ...OFFLINE,
      stack: null,
      alias: { ...OFFLINE.alias!, projectPath: null },
    });
    expect(html).toContain("This alias has no project folder");
    expect(html).not.toContain("We do not recognise");
  });

  test("the right-port-wrong-interface case is spelled out with a real check", () => {
    const html = offlineHtml(OFFLINE);
    expect(html).toContain('data-testid="offline-interface"');
    expect(html).toContain("lsof -nP -iTCP:3000 -sTCP:LISTEN");
    expect(html).toContain("::1");
    expect(html).toContain("0.0.0.0");
    expect(html).toContain("--host");
  });

  test("the live reading flips, and only then offers the way back", () => {
    expect(offlineHtml(OFFLINE)).not.toContain("Open shop.test");
    const up = offlineHtml({ ...OFFLINE, listening: true });
    expect(up).toContain('data-listening="true"');
    expect(up).toContain("listening");
    expect(up).toContain("Open shop.test");
    expect(up).toContain("Something is accepting connections there now");
    // The bind-address troubleshooting answers a question the user no longer has.
    expect(offlineHtml(OFFLINE)).toContain('data-testid="offline-interface"');
    expect(up).not.toContain('data-testid="offline-interface"');
  });

  test("a hostname nothing is patched to gets a page, not a blank", () => {
    const html = offlineHtml({ ...OFFLINE, known: false, alias: null, stack: null });
    expect(html).toContain('data-testid="offline-unknown"');
    expect(html).toContain("Nothing is patched to shop.test");
    expect(html).toContain("Open the patchbay");
  });

  /**
   * The page must never assert that the root agent is answering just because the user is
   * looking at it: /offline is also reachable straight from the dashboard, and a claim
   * about the machine has to come from the machine.
   */
  test("it says which of the two problems this is, and never guesses", () => {
    expect(offlineHtml(OFFLINE, null, true)).toContain("the root agent is answering");

    const agentDown = offlineHtml(OFFLINE, null, false);
    expect(agentDown).toContain("The root agent is not running either");
    expect(agentDown).toContain("That is the first thing to fix");
    expect(agentDown).not.toContain("the root agent is answering");

    const unknown = offlineHtml(OFFLINE, null, null);
    expect(unknown).not.toContain("the root agent is answering");
    expect(unknown).not.toContain("is not running either");
  });

  test("a failed re-check is reported without erasing what was already read", () => {
    const html = offlineHtml(OFFLINE, "Cannot reach the dashboard server");
    expect(html).toContain('data-testid="offline-error"');
    expect(html).toContain("nothing on your Mac has changed");
    expect(html).toContain("next dev -p 3000");
  });

  test("before the first read it says so rather than claiming the port is dead", () => {
    const html = offlineHtml(null);
    expect(html).toContain('data-testid="offline-loading"');
    expect(html).not.toContain("Nothing is accepting connections");
  });
});
