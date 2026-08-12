# apps/tray — Localhost Aliases menu bar app

A native macOS menu-bar app (Swift + AppKit, no dependencies) that supervises the
`packages/web` server and gives one-click access to every alias.

`LSUIElement` is `true`: no dock icon, no window, ever. The only UI is the menu bar item.

## Build

```sh
cd apps/tray
make app
```

| target  | what it does                                                        |
| ------- | ------------------------------------------------------------------- |
| `build` | compiles the executable to `.build/LocalhostAliases`                 |
| `app`   | assembles `LocalhostAliases.app` (implies `build`), ad-hoc signs it  |
| `run`   | `app`, then `open`s it — it appears in the menu bar, not the dock    |
| `clean` | removes `.build/` and `LocalhostAliases.app`                         |

The bundle lands at **`apps/tray/LocalhostAliases.app`**:

```
LocalhostAliases.app/
  Contents/
    Info.plist            # copied from apps/tray/Info.plist
    MacOS/LocalhostAliases
    PkgInfo
    Resources/
```

Both build products are gitignored. To install it for real, copy the bundle to
`/Applications` and add it to *System Settings → General → Login Items*.

Requirements: macOS 13+, the Xcode command line tools (`swiftc`, `xcrun`). No SwiftPM, no
network access, no package dependencies — only AppKit and Foundation.

## What it does

**Supervises the web server.** It launches `bun run --cwd <root>/packages/web start` from the
install root (`/usr/local/lib/localhost-aliases`, or the repo checkout the bundle sits in when
developing) and keeps it alive:

- stdout and stderr are appended to `~/Library/Logs/localhost-aliases/web.log`, interleaved
  with `[tray …]` supervisor lines so the log explains its own gaps. Rotated to `web.log.1`
  past 5 MB.
- an unexpected exit is restarted with capped backoff (1, 2, 5, 10, 20, 30s); a child that
  stays up 30s resets the backoff. A stop the user asked for is never restarted.
- the child is spawned in **its own process group**, so quitting the tray signals `bun` *and*
  the `next` grandchild. Quit, SIGTERM and SIGINT all take the server down cleanly.
- if something already answers on the dashboard port (the LaunchAgent, or `scripts/dev.sh`),
  the tray adopts it instead of fighting for the port, and greys out Stop/Restart. If that
  external server later dies, the tray takes over supervision.

**Polls the API** every 5s: `GET /api/health` for liveness, `GET /api/aliases` for the menu
(also refreshed the moment the menu opens). Requests time out in 2.5s and never overlap.

## Menu

```
Running · 4 aliases          <- status line: Stopped / Starting… / Running · N aliases / Error · …
Open Dashboard        ⌘D
ALIASES
 ● myapp.local  :3000        <- click opens the alias URL; dot = up / down / unknown
 ● api.local    :8080
Restart Server        ⌘R
Stop Server                  <- becomes Start Server when stopped
Open Server Log
Quit Localhost Aliases ⌘Q
```

## Status icon

Each state gets its **own SF Symbol**, because shape is the only thing that survives every
menu bar context — light, dark, highlighted, reduced transparency:

| state    | symbol                                | rendering            |
| -------- | ------------------------------------- | -------------------- |
| stopped  | `pause.circle`                        | template             |
| starting | `arrow.triangle.2.circlepath`         | template             |
| running  | `point.3.connected.trianglepath.dotted` | template           |
| error    | `exclamationmark.triangle.fill`       | tinted `systemRed`   |

Template images are inverted by AppKit for the current menu bar appearance, so they are always
legible. Only the error state opts out of template rendering — an alert is worth the exception
— and it uses a dynamic system colour drawn through an `NSImage` drawing handler, which is
re-run per appearance, so it resolves correctly in light and dark too.

## Environment overrides

Mirrors `packages/core/src/paths.ts`, plus two tray-only ones for development:

| variable            | effect                                                     |
| ------------------- | ---------------------------------------------------------- |
| `LA_DASHBOARD_PORT` | dashboard port to supervise and poll (default `7788`)       |
| `LA_LOG_DIR`        | log directory (default `~/Library/Logs/localhost-aliases`)  |
| `LA_INSTALL_ROOT`   | runtime root to launch `packages/web` from                  |
| `LA_BUN`            | path to the `bun` binary                                    |

A `.app` launched from Finder inherits a bare `PATH`, so `bun` is located explicitly:
`LA_BUN`, then `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `~/.bun/bin`.

## Source layout

One responsibility per file:

| file                 | responsibility                                                |
| -------------------- | ------------------------------------------------------------- |
| `main.swift`         | entry point; accessory activation policy                      |
| `AppDelegate.swift`  | wiring and app state; signal handling; menu actions           |
| `ServerProcess.swift`| supervision policy: start/stop/restart, backoff, adoption     |
| `ChildProcess.swift` | `posix_spawn` primitive: own process group, fd redirection    |
| `HealthPoller.swift` | the web API client and its polling loop                       |
| `LogFile.swift`      | append-only log file and rotation                             |
| `StatusMenu.swift`   | `NSStatusItem` + `NSMenu` assembly                            |
| `StatusIcon.swift`   | image construction (template vs tinted)                       |
| `TrayState.swift`    | the state the menu bar renders                                |
| `Paths.swift`        | Swift mirror of `packages/core/src/paths.ts`                  |

All state is main-thread confined; background work (child exits, HTTP) hops back to the main
queue before touching anything.
