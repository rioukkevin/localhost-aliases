# Phase 4 — production packaging + product reorganisation

Two tracks run in parallel. They touch one shared surface: **how the app is laid out and
launched**. That contract is frozen here. Read it before writing code in either track.

Verified facts about this machine (do not re-litigate):
- `bun build --compile` produces a working standalone arm64 Mach-O (~55 MB). Tested on the helper.
- A **Developer ID Application** certificate exists: `RIOU Kevin (UYB68P6HH7)`.
- `xcrun notarytool` has **no stored credentials yet** — only Kevin can create them. Build the
  pipeline right up to submission; never attempt to submit, and never ask for a password.
- macOS 26.3, so `SMAppService` (13+) is available.

---

## 1. Runtime layout contract (FROZEN)

The app must run in two contexts. Everything that spawns a process or resolves an asset goes
through this, and nothing may assume a git checkout.

| | `dev` (git clone) | `bundle` (installed .app) |
|---|---|---|
| Detected by | `LA_RUNTIME=dev` or no bundle marker | executable path contains `.app/Contents/` |
| Web server | `bun --bun next start` in `packages/web` | `Contents/Resources/bin/bun` running `Contents/Resources/web/server.js` |
| Helper | `bun packages/helper/src/index.ts` under `sudo` | `Contents/MacOS/la-helper` (compiled), installed by `SMAppService` |
| Helper socket | `LA_SOCKET_PATH` temp override | `/var/run/localhost-aliases.sock` |
| Config + CA | `LA_CONFIG_DIR` or `~/.config/localhost-aliases` | same (user-space, unchanged) |

Bundle layout, frozen:

```
LocalhostAliases.app/Contents/
├── Info.plist                              LSUIElement, bundle id dev.localhost-aliases.tray
├── MacOS/
│   ├── LocalhostAliases                    the Swift tray (main executable)
│   └── la-helper                           bun --compile of packages/helper (root daemon)
├── Library/LaunchDaemons/
│   └── dev.localhost-aliases.helper.plist  BundleProgram = Contents/MacOS/la-helper
└── Resources/
    ├── bin/bun                             embedded Bun runtime, signed separately
    └── web/                                next build with output:"standalone" + .next/static + public
```

`Contents/Library/LaunchDaemons/` and a daemon executable under `Contents/MacOS/` are both
required by `SMAppService.daemon` — this is not a stylistic choice.

## 2. Helper installation contract (FROZEN)

`scripts/install.sh` becomes **dev-only**. Production installs the daemon with
`SMAppService.daemon(plistName:).register()`, which raises one admin prompt and puts the daemon
in System Settings › Login Items, where the user can disable it. Login-at-launch uses
`SMAppService.mainApp.register()`.

Only the tray process can call `SMAppService`. The dashboard therefore cannot install the helper
itself. `GET /api/status` gains one field:

```ts
helper.installMethod: "bundle" | "script"
```

- `"script"` (dev): the banner keeps showing the copyable `sudo ./scripts/install.sh`.
- `"bundle"` (production): the banner instead says the helper is not installed yet and directs the
  user to the menu-bar icon → **Install Helper…**. It must NOT show a sudo command in this mode.

The tray exposes **Install Helper…** whenever `/api/status` reports the helper missing, and
surfaces `SMAppService.Status` (`.notRegistered`, `.enabled`, `.requiresApproval`, `.notFound`)
in plain language — `requiresApproval` in particular must tell the user to approve it in System
Settings, or it looks silently broken.

## 3. Shared UI contract (FROZEN)

`packages/web/components/FolderPicker.tsx` is written by the folder-picker agent and consumed by
the project-first agent. Both code against exactly this:

```tsx
export interface FolderPickerProps {
  value: string | null;                        // absolute POSIX path, or null
  onChange: (path: string | null) => void;
  label?: string;
  disabled?: boolean;
  "data-testid"?: string;                      // default "folder-picker"
}
export function FolderPicker(props: FolderPickerProps): JSX.Element;
```

Backed by `POST /api/pick-folder` → `{ path: string } | { cancelled: true }`, which shells
`osascript -e 'choose folder'`. Requirements:
- Return the **absolute POSIX path**, not an HFS colon path.
- `osascript` blocks, so the route must time out (60s) rather than hang a Next worker forever.
- The dialog opens behind the browser unless the process is activated first — handle it.
- It cannot run headless, so gate it on `LA_FOLDER_PICKER=stub` returning a fixed path, and use
  that in e2e. Never let a test open a real dialog.

## 4. HTTPS / onboarding contract

- `DEFAULT_CONFIG.https` becomes `true` for new installs. Existing configs keep their value.
- The CA is trusted in the **login keychain**, from onboarding:
  `security add-trusted-cert -k ~/Library/Keychains/login.keychain-db ...`. This raises a macOS
  password dialog. **No agent may ever execute this** — build it, gate it behind an explicit user
  click, and test the surrounding logic with the command stubbed.
- `certs.isCATrusted()` currently probes the **System** keychain; it must probe the login keychain
  too, and report which one.
- Firefox uses its own certificate store and will still warn. Say so in onboarding rather than
  letting it look broken.
- HTTP keeps working (decision: serve both, prefer https in the UI). The dashboard shows and
  copies `https://` URLs, with a padlock state per alias: trusted / untrusted / http-only.

## 5. Project-first model

- Projects become the primary view; aliases are created inside a project.
- `Alias.projectPath` stays **optional**. The Aliases view groups by project with an
  **Unassigned** group. Do not make it required — that would break the MCP contract and 621 tests.
- Absorb the deferred polish here rather than as separate work: consolidate the duplicate
  `/api/status` polling (StatusStrip 10s vs useAliases 5s) onto one source of truth, and add
  "detach alias from project".

## 6. Signing and notarisation

Every nested binary (`la-helper`, `Resources/bin/bun`) must be signed **before** the outer bundle,
with Developer ID + hardened runtime + `--options runtime --timestamp`. Bun JITs, so it needs
entitlements: `com.apple.security.cs.allow-jit`, and likely
`com.apple.security.cs.allow-unsigned-executable-memory` and
`com.apple.security.cs.disable-library-validation`. Start permissive, then remove each one and
re-verify — do not ship entitlements you have not proven necessary.

Verification that costs nothing and catches most mistakes:
`codesign --verify --deep --strict --verbose=2` and `spctl -a -vvv -t install`.

Notarisation is the last step and requires Kevin's credentials. Write
`scripts/package/notarize.sh` so it works once credentials exist, print the exact
`xcrun notarytool store-credentials` command he must run himself, and stop there.
