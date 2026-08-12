# Entitlements

`bun.plist` is applied by `sign.sh` to the two Bun-based binaries in the bundle:

- `Contents/Resources/bin/bun` — the embedded runtime that runs the Next.js server
- `Contents/MacOS/la-helper` — `bun build --compile` of `packages/helper`

The Swift tray (`Contents/MacOS/LocalhostAliases`) and the outer `.app` get **no**
entitlements, and neither do the nested native modules (`sharp`'s `.dylib` / `.node`).

## Why exactly one entitlement

Hardened runtime turns on W^X: a process may not have memory that is both writable and
executable. JavaScriptCore is compiled into Bun and dies without JIT memory. Measured on
this machine (macOS 26.3, Bun 1.2.5, real Developer ID signature, `--options runtime
--timestamp`), booting both binaries for real — the helper binding its proxy and writing a
managed hosts block, the runtime serving `/api/health` from the standalone Next build:

| Entitlements | Result |
|---|---|
| `allow-jit` + `allow-unsigned-executable-memory` + `disable-library-validation` | both run |
| `allow-jit` + `allow-unsigned-executable-memory` | both run |
| `allow-jit` + `disable-library-validation` | both run |
| **`allow-jit`** | **both run — shipped** |
| `allow-unsigned-executable-memory` + `disable-library-validation` | both run |
| `allow-unsigned-executable-memory` | both run |
| *(none)* | both `SIGTRAP` at startup: `Ran out of executable memory while allocating 128 bytes.` |

Two entitlements can satisfy Bun, so the choice is which one is narrower:

- `com.apple.security.cs.allow-jit` permits `mmap` with `MAP_JIT` — one region, still
  covered by the runtime's per-thread W^X switching.
- `com.apple.security.cs.allow-unsigned-executable-memory` removes the restriction from the
  whole process, and is the entitlement Apple explicitly tells you to avoid when `allow-jit`
  is sufficient.

`disable-library-validation` is never needed. It exists to load code signed by *another*
team; `sign.sh` re-signs every nested `.dylib` and `.node` with our own Developer ID, so
library validation is satisfied by construction. Verified by `require`ing `sharp` (the only
native addon in the bundle) inside the signed runtime — it loads.

## Editing these

Entitlement plists are parsed by AMFI, not by the ordinary plist parser, and **AMFI rejects
XML comments**:

```
Failed to parse entitlements: AMFIUnserializeXML: syntax error near line 6
```

Keep `bun.plist` comment-free; the reasoning lives in this file. To retry the experiment
with a different set, put it in a plist and run
`scripts/package/sign.sh --entitlements <path>`.
