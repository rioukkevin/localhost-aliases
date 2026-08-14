# RELEASE.md — cutting and publishing a release

One tag starts everything. `.github/workflows/release.yml` builds the `.app`, signs it, notarizes
it, staples the ticket, packages a DMG, uploads it to Vercel Blob with a manifest the site reads,
and creates a GitHub Release as a durable mirror.

Nothing in this document requires the `vercel` CLI, and nothing publishes from a laptop.

---

## 1. What ships where

| Artifact | Location | Who writes it |
|---|---|---|
| `LocalhostAliases-<version>.dmg` | `releases/LocalhostAliases-<version>.dmg` on Vercel Blob | `packages/build/publish.ts` |
| `latest.json` | `releases/latest.json` on Vercel Blob | `packages/build/publish.ts` |
| The same DMG + `.sha256` | GitHub Release for the tag | `softprops/action-gh-release` |
| The same DMG + `.sha256` | Workflow artifact, 90 days | `actions/upload-artifact` |

Both blob paths are written with `addRandomSuffix: false`, so
`${NEXT_PUBLIC_BLOB_BASE_URL}/releases/latest.json` is a URL the site can hardcode.

The manifest schema is frozen in [docs/WEB.md](WEB.md). Its `releases` array is the changelog:
`publish.ts` reads the manifest that is already published and **prepends** the new release, so
shipping 2.1.0 never erases 2.0.0. If the stored manifest is missing (the first release ever) it
starts a fresh one; if it is unreadable it publishes anyway with a warning, because a corrupt
manifest must not block a release.

---

## 2. One-time setup

### 2.1 GitHub Actions secrets

_Repository → Settings → Secrets and variables → Actions → New repository secret._

| Secret | Where it comes from |
|---|---|
| `DEVELOPER_ID_P12` | Keychain Access → export your **Developer ID Application** certificate as `.p12` → `base64 -i cert.p12 \| pbcopy` |
| `DEVELOPER_ID_P12_PASSWORD` | the password you typed during that export |
| `KEYCHAIN_PASSWORD` | any random string, e.g. `openssl rand -hex 24`; it only scopes the throwaway CI keychain |
| `AC_API_KEY_ID` | App Store Connect → Users and Access → Integrations → App Store Connect API → the key's Key ID |
| `AC_API_ISSUER_ID` | the Issuer ID on that same page (a UUID) |
| `AC_API_KEY_P8` | the contents of the downloaded `AuthKey_XXXXXX.p8`, pasted verbatim including the BEGIN/END lines |
| `BLOB_READ_WRITE_TOKEN` | Vercel dashboard → Storage → your Blob store → **Tokens** (or the `.env.local` the store's "Quickstart" tab offers). It is a read-write token; treat it like a password |

Every one of these is optional as far as the workflow is concerned:

- no `DEVELOPER_ID_P12` → the build is unsigned, and the verify step logs warnings instead of failing
- no `AC_API_KEY_P8` → no notarization, no stapled ticket
- no `BLOB_READ_WRITE_TOKEN` → the DMG is still built and still attached to the GitHub Release; only
  the blob upload is skipped

That is what makes a fork work: `secrets` cannot be read from a step-level `if:`, so presence is
hoisted into job-level `env` (`HAS_SIGNING_CERT`, `HAS_NOTARY_KEY`, `HAS_BLOB_TOKEN`) and the steps
test those. A fork has none of them and skips cleanly instead of failing red.

**Do not publish a build as signed or notarized when it was not.** The site's copy must match what
the pipeline actually did.

### 2.2 The Vercel project (the site)

The site is **deployed by Vercel, not by CI**. `.github/workflows/site.yml` only proves a PR does
not break it.

_Vercel dashboard → Add New → Project → import `rioukkevin/localhost-aliases`._

| Setting | Value |
|---|---|
| Framework preset | Next.js |
| **Root Directory** | `packages/site` |
| Include source files outside of the Root Directory | **enabled** — the workspace lockfile lives at the repo root |
| Install Command | from `packages/site/vercel.json`: `cd ../.. && bun install --frozen-lockfile` |
| Build Command | the Next.js preset default |
| Node/Bun | Bun is detected from `bun.lock` |

`packages/site/vercel.json` holds those first settings so they live in git rather than only in a
dashboard. It sits in `packages/site/` and not at the repo root because Vercel reads `vercel.json`
from the configured Root Directory. Its `ignoreCommand` skips a deployment when a commit touched
nothing under `packages/site` (and not the root manifests), so app-only commits do not redeploy the
site.

Environment variables — _Project → Settings → Environment Variables_, set for **Production,
Preview and Development**:

| Var | Value | Purpose |
|---|---|---|
| `NEXT_PUBLIC_BLOB_BASE_URL` | `https://<store-id>.public.blob.vercel-storage.com` | the base the site reads `releases/latest.json` from |

Find `<store-id>` in the Blob store's dashboard, or in the URL of any blob you have uploaded. **No
trailing slash.** The token itself is never needed by the site: everything it reads is public.

The site must render correctly when `releases/latest.json` does not exist — that is the state until
the first release is published, and the PR workflow deliberately builds with no blob URL set so
that path stays exercised.

---

## 3. Cutting a release

```sh
# 1. Bump the one version that matters. Everything else derives from it: the DMG filename,
#    Info.plist's CFBundleShortVersionString and CFBundleVersion, the manifest.
$EDITOR package.json          # "version": "2.1.0"

# 2. Prove it still builds and passes locally.
bun test packages
make bundle

# 3. Commit, then tag. An annotated tag's message becomes the release notes, on the site and on
#    GitHub — write it for a user, not for a reviewer.
git commit -am "release: 2.1.0"
git tag -a v2.1.0 -m "$(cat <<'EOF'
### Added
- ...

### Fixed
- ...
EOF
)"
git push origin master
git push origin v2.1.0
```

The tag is the trigger. `v*` on push starts the workflow.

If the tag carries no message (a lightweight `git tag v2.1.0`), CI falls back to the commit subjects
since the previous tag, and to `First published release.` when there is no previous tag.

### What CI then does, in order

1. `bun test packages` — the whole unit suite, no e2e, nothing privileged.
2. **Version gate:** `v2.1.0` → `2.1.0`, compared with `package.json`. This runs before the build,
   so a mismatch costs ten seconds rather than a notarization round-trip.
3. `make bundle`, then the same check again against the built
   `Info.plist` → `CFBundleShortVersionString`. A DMG labelled 2.1.0 that reports 2.0.0 inside is
   exactly what nobody notices until a user reports it.
4. Import the Developer ID cert into a temporary keychain, `make sign`.
5. `make notarize` — submit, wait, staple.
6. `make dmg`, then verify it the way a Mac will (`codesign`, `spctl`, `stapler validate`).
7. Checksum the DMG **in the shell** (`shasum -a 256`), write the `.dmg.sha256` sidecar, and export it.
8. Compose the release notes.
9. `publish.ts`: recompute the SHA-256 **in Bun** and refuse to continue if the two disagree, assert
   the version one last time against the bundle, upload the DMG, then read + merge + write
   `releases/latest.json`.
10. Create the GitHub Release with the DMG, the `.sha256` and the notes, sha256 in the body.

Two independent checksum implementations have to agree before anything is published. That is the
point of computing it twice.

### Guards worth knowing about

- **Downgrade refused.** If `latest.json` already advertises a newer version, `publish.ts` stops
  rather than telling every user to downgrade. `--allow-downgrade` overrides it, deliberately.
- **Filename gate.** The DMG must be named `LocalhostAliases-<version>.dmg`; the blob path is
  derived from it, and the site's download link depends on that shape.
- **Idempotent.** Re-running a tag's workflow overwrites the same two blob paths and replaces (does
  not duplicate) that version's entry in the history. Re-running is the normal fix for a failed
  upload.

---

## 4. Verifying a published build on a clean Mac

Do this on a machine that has never built this app — a second Mac, or a fresh user account. The
point is to see what a stranger sees.

```sh
V=2.1.0
BASE=https://<store-id>.public.blob.vercel-storage.com

# 1. What the site will offer, and what it claims about it.
curl -s "$BASE/releases/latest.json" | python3 -m json.tool

# 2. Download exactly that URL.
curl -fLO "$BASE/releases/LocalhostAliases-$V.dmg"

# 3. The checksum must equal the manifest's dmg.sha256 and the GitHub Release body.
shasum -a 256 "LocalhostAliases-$V.dmg"
#   or, with the sidecar from the GitHub Release:
#   shasum -c "LocalhostAliases-$V.dmg.sha256"

# 4. Mount it and check the app itself.
hdiutil attach "LocalhostAliases-$V.dmg" -nobrowse
APP="/Volumes/Localhost Aliases/LocalhostAliases.app"

codesign --verify --deep --strict --verbose=2 "$APP"
#   expect: satisfies its Designated Requirement

spctl -a -vvv -t install "$APP"
#   expect: accepted / source=Notarized Developer ID

xcrun stapler validate "$APP"
#   expect: The validate action worked!

/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist"
#   expect: the same version as the tag, the filename and the manifest

hdiutil detach "/Volumes/Localhost Aliases"
```

`spctl` accepting **offline** is the real test: a stapled ticket means Gatekeeper does not need to
reach Apple, which is what a user behind a captive portal will experience. Pull the network cable and
run it again if you want to be sure.

Then actually run it once, from `/Applications`, and complete onboarding. The DMG can be perfect and
the app still broken.

---

## 5. Brand assets are not part of this pipeline

`packages/assets` is local-only (see [docs/WEB.md](WEB.md)). No workflow installs Remotion,
downloads a browser or renders anything. The icon, favicons, OG image and hero video are **committed
files**, and both `make bundle` and the site build consume them as they are.

Regenerating them is a deliberate local step, done before the release commit:

```sh
bun run --cwd packages/assets render:all
bun run packages/assets/scripts/sync.ts
git add apps/tray/Resources packages/site/public
git commit -m "assets: re-render"
```

A CI failure caused by a missing asset means someone forgot to commit a render. It is never a reason
to add a render step to a workflow.

---

## 6. When something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `version mismatch — the tag and the shipped binary disagree` | tagged without bumping `package.json` | delete the tag, bump, re-tag. Never edit the plist by hand |
| `checksum mismatch for dist/…dmg` | the DMG changed between the two hashes, or a truncated write | re-run the workflow; if it repeats, the runner is at fault, not the code |
| `BLOB_READ_WRITE_TOKEN is not set` in a step that should have run | the secret is missing or the run is from a fork | add the secret; the DMG on the GitHub Release is unaffected |
| `latest.json already advertises 2.2.0` | publishing an older tag after a newer one | intended? pass `--allow-downgrade`. Otherwise stop — you are about to downgrade every user |
| The blob upload half-finished | a network failure mid-upload | just re-run the tag's workflow; both paths are overwritten in place |
| The site shows build-from-source instructions after a release | `NEXT_PUBLIC_BLOB_BASE_URL` unset, wrong, or has a trailing slash | fix the Vercel env var and redeploy |

**Rolling back** is a publish, not a delete: re-tag the previous known-good commit as a new patch
version and let the pipeline run. Deleting a blob leaves users with a download link that 404s,
whereas an older manifest simply points everyone at a build that works.

---

## 7. Trying the publisher without publishing

`publish.ts --dry-run` touches no network at all. It hashes the real DMG, reads the real
`Info.plist`, asserts the versions and prints the manifest it would upload. Because it reads
nothing, it behaves as if the store were empty: the history it prints contains only this release.

```sh
make bundle && make dmg
bun run packages/build/publish.ts \
  --tag v2.0.0 \
  --dmg dist/LocalhostAliases-2.0.0.dmg \
  --app dist/LocalhostAliases.app \
  --expect-sha256 "$(shasum -a 256 dist/LocalhostAliases-2.0.0.dmg | cut -d' ' -f1)" \
  --dry-run
```

The merging rules themselves — prepend, first release, corrupt manifest, downgrade, re-publish —
are unit-tested in `packages/build/test/`, with the network behind an interface that the tests
replace. `bun test packages/build`.
