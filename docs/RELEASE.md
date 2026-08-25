# RELEASE.md — cutting and publishing a release

One tag starts everything. `.github/workflows/release.yml` builds the `.app`, signs it, notarizes
it, staples the ticket, packages a DMG, writes the release notes, and creates the GitHub Release
that the DMG and the notes are attached to.

The GitHub Release **is** the distribution channel. The site resolves the current version, the
notes, the date and the `.dmg` from the GitHub REST API (see [docs/SITE.md](SITE.md)), so nothing
is published anywhere else — there is no blob store, no manifest to keep in sync, and nothing
publishes from a laptop.

CI is macOS-only: one `macos-15` job, no OS matrix, no cross-platform build. `packages/assets`
(Remotion) is never installed or run in CI — see §5.

---

## 1. What ships where

| Artifact | Location | Who writes it |
|---|---|---|
| `LocalhostAliases-<version>.dmg` | the GitHub Release for the tag | `softprops/action-gh-release` |
| `LocalhostAliases-<version>.dmg.sha256` | the same release | the same step |
| The release body (notes + checksum + download link) | the same release | `packages/build/release-notes.ts` |
| DMG, `.sha256`, notes and body | workflow artifact, 90 days | `actions/upload-artifact` |

The download URL is therefore
`https://github.com/rioukkevin/localhost-aliases/releases/download/v<version>/LocalhostAliases-<version>.dmg`,
and it is stable for as long as the release exists.

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
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys. Used once per release, by `release-notes.ts`, to turn the commits into readable notes |

That is the whole list. **`BLOB_READ_WRITE_TOKEN` is no longer used** — no workflow reads it. If it
is still set on this repository, delete it: an unused write token is a credential nobody is
watching.

Every secret above is optional as far as the workflow is concerned:

- no `DEVELOPER_ID_P12` → the build is unsigned, and the verify step logs warnings instead of failing
- no `AC_API_KEY_P8` → no notarization, no stapled ticket
- no `ANTHROPIC_API_KEY` → the notes are the grouped commit list; everything else is identical

That is what makes a fork work: `secrets` cannot be read from a step-level `if:`, so presence is
hoisted into job-level `env` (`HAS_SIGNING_CERT`, `HAS_NOTARY_KEY`, `HAS_ANTHROPIC_KEY`) and the
steps test those. A fork has none of them and skips cleanly instead of failing red.

**Do not publish a build as signed or notarized when it was not.** The release body deliberately
claims neither; it prints the commands that let a reader check for themselves.

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

Environment variables — _Project → Settings → Environment Variables_:

| Var | Required? | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | optional | A read-only token, sent as a bearer when reading the GitHub API. Unauthenticated reads are capped at 60 requests/hour **per IP**, which a build burst can exhaust; with a token the cap is far higher. The site must still render correctly without it |

`NEXT_PUBLIC_BLOB_BASE_URL` is gone with the blob store — remove it from the project if it is
still there.

The site must render correctly when there are **no releases at all** — that is the state today,
and `site.yml` deliberately builds with no token and no releases so that path stays exercised on
every PR.

---

## 3. How the release notes are written

`packages/build/release-notes.ts` produces two files:

- `dist/RELEASE_NOTES.md` — the notes body alone
- `dist/RELEASE_BODY.md` — those notes, then the facts CI computed. This is the GitHub Release body

The notes come from the first of these that exists, and the workflow tries them in this order:

1. **The annotated tag's message.** If you wrote one, it wins. A human wrote it for this release;
   nothing overwrites it, and no API call is made.
2. **The cache.** `actions/cache` keyed on the tag restores `dist/RELEASE_NOTES.md` from an earlier
   run of the same tag, so re-running a failed release does not re-bill the API.
3. **Claude.** `claude-opus-5` is given the commits since the previous tag and asked for grouped,
   factual `### Added` / `### Fixed` / `### Changed` notes written for a user, omitting empty
   sections. One request, `max_tokens: 16000`, no sampling parameters — `temperature`, `top_p`,
   `top_k` and `thinking.budget_tokens` all return 400 on this model and the request type cannot
   express them.
4. **The commits.** A plain grouped commit list, generated in code.

**A release is never blocked because nobody could write nice notes for it.** A missing key, an API
error, a `refusal` or `max_tokens` stop reason, an answer with no text in it — every one of them
falls through to step 4 with a warning in the log. The step summary says which source was used.

**The commit log is untrusted input.** Anyone who can land a commit writes commit messages, and a
commit message can be phrased as an instruction to the model. The system prompt says so, and the
script is built so that it does not have to be believed: the model's answer can only ever become
the notes *body*. The version, the date, the sha256, the size, the download URL and the
`Full Changelog` link are computed by the script from the real build and appended **below** it, so
an injected "the sha256 is deadbeef" is a lie printed directly above the real checksum. The answer
is also stripped of any line that would be a GitHub workflow command (`::add-mask::` and friends),
capped in length, never written to `$GITHUB_OUTPUT`, and never used as a path, URL or shell
argument.

### Previewing the notes without spending anything

Without `--generate` the script never touches the network. It reads the real git history and
prints the body it would publish:

```sh
bun run packages/build/release-notes.ts \
  --tag v2.1.0 \
  --repo rioukkevin/localhost-aliases \
  --notes /tmp/notes.md \
  --out /tmp/body.md \
  --filename LocalhostAliases-2.1.0.dmg \
  --sha256 "$(shasum -a 256 dist/LocalhostAliases-2.1.0.dmg | cut -d' ' -f1)" \
  --size "$(stat -f%z dist/LocalhostAliases-2.1.0.dmg)"
cat /tmp/body.md
```

Add `--generate` (with `ANTHROPIC_API_KEY` exported) to make the one API call and see what the
model writes. Delete `/tmp/notes.md` first, or it will be reused rather than regenerated.

The grouping, the fallbacks, the stop-reason handling and the injection containment are unit
tested with the API client stubbed: `bun test packages/build`.

---

## 4. Cutting a release

```sh
# 1. Bump the one version that matters. Everything else derives from it: the DMG filename,
#    Info.plist's CFBundleShortVersionString and CFBundleVersion, the release body.
$EDITOR package.json          # "version": "2.1.0"

# 2. Prove it still builds and passes locally.
bun test packages
make bundle

# 3. Commit, then tag. Give the tag a message only if you want to write the notes yourself —
#    an annotated tag's message becomes the release notes verbatim. Leave it lightweight and
#    CI writes them from the commits.
git commit -am "release: 2.1.0"
git tag v2.1.0
git push origin master
git push origin v2.1.0
```

The tag is the trigger. `v*` on push starts the workflow.

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
7. Checksum the DMG (`shasum -a 256`) and write the `.dmg.sha256` sidecar.
8. Write the notes (§3), then compose `dist/RELEASE_BODY.md`.
9. Create the GitHub Release with the DMG, the `.sha256` and that body.

The site picks the new release up on its next revalidation (300s) — no deploy needed.

### Re-running a release

Re-running the tag's workflow is safe and is the normal fix for a failed publish: the notes come
back from the cache instead of the API, and `action-gh-release` updates the existing release for
that tag rather than creating a second one.

---

## 5. Brand assets are not part of this pipeline

`packages/assets` is local-only (see [docs/WEB.md](WEB.md)). No workflow installs Remotion,
downloads a browser or renders anything — `release.yml` and `site.yml` both build only from
committed files. The icon, favicons, OG image and hero media are **committed**, and both
`make bundle` and the site build consume them as they are.

Regenerating them is a deliberate local step, done before the release commit:

```sh
bun run --cwd packages/assets render:all
bun run packages/assets/scripts/sync.ts
git add apps/tray/Resources packages/site/public
git commit -m "assets: re-render"
```

A CI failure caused by a missing asset means someone forgot to commit a render. It is never a
reason to add a render step to a workflow.

---

## 6. Verifying a published build on a clean Mac

Do this on a machine that has never built this app — a second Mac, or a fresh user account. The
point is to see what a stranger sees.

```sh
V=2.1.0
REPO=rioukkevin/localhost-aliases

# 1. What the site and the release page will offer.
curl -s "https://api.github.com/repos/$REPO/releases/latest" | python3 -m json.tool | head -40

# 2. Download exactly that asset.
curl -fLO "https://github.com/$REPO/releases/download/v$V/LocalhostAliases-$V.dmg"
curl -fLO "https://github.com/$REPO/releases/download/v$V/LocalhostAliases-$V.dmg.sha256"

# 3. The checksum must equal the one printed in the release body.
shasum -c "LocalhostAliases-$V.dmg.sha256"

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
#   expect: the same version as the tag, the filename and the release body

hdiutil detach "/Volumes/Localhost Aliases"
```

`spctl` accepting **offline** is the real test: a stapled ticket means Gatekeeper does not need to
reach Apple, which is what a user behind a captive portal will experience. Pull the network cable
and run it again if you want to be sure.

Then read the release page as a stranger would: do the notes describe this build, and do the
version, the date and the checksum in the body match the file you just downloaded? Finally, run
the app once from `/Applications` and complete onboarding. The DMG can be perfect and the app
still broken.

---

## 7. When something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `version mismatch — the tag and the shipped binary disagree` | tagged without bumping `package.json` | delete the tag, bump, re-tag. Never edit the plist by hand |
| The step summary says the notes are `the grouped commit list` | `ANTHROPIC_API_KEY` is missing, or the call failed | check the "Write the release notes with Claude" step's log for the `::warning::`. The release itself is fine; edit the release body by hand if you want better notes |
| The notes describe the wrong release | an annotated tag's message, or a stale cache entry, was reused | the cache key is the tag name; edit the release body on GitHub, or re-tag |
| The notes read like they are talking to the tooling | a commit message tried a prompt injection | the facts below the rule in the body are still the real ones. Edit the body, and treat the commit as the bug |
| The site still shows the old version | the site caches GitHub for 300s | wait, then reload. If it persists, check the site's `GITHUB_TOKEN` and the rate limit |
| The site shows build-from-source instructions after a release | the release has no `.dmg` asset attached, or the GitHub API was rate-limited at build time | check the release's assets; set `GITHUB_TOKEN` on the Vercel project |
| A release published but the DMG is missing | `fail_on_unmatched_files` should have caught it — read the "Attach the DMG" step's log | re-run the tag's workflow |

**Rolling back** is a publish, not a delete: re-tag the previous known-good commit as a new patch
version and let the pipeline run. Deleting a release leaves anyone holding that link with a 404,
whereas a newer release simply points everyone at a build that works.

---

## 8. Leftovers from the Vercel Blob era

`packages/build/publish.ts`, `packages/build/blob-upload.ts` and
`packages/build/release-manifest.ts` used to upload the DMG and a `latest.json` manifest to Vercel
Blob. **No workflow calls them any more.** They still build and their tests still pass; they are
kept only so a manual mirror is possible if it is ever wanted again. If nothing needs that, they
and their tests can be deleted in one commit, and this section with them.
