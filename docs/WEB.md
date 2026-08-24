# Website + brand assets — contract

Two tracks, built in parallel. Everything below is frozen; agents fill in their own directory.

## Verified environment facts (do not re-litigate)

- Remotion **4.0.410** is installed and renders here. `bun install` is done.
- Remotion's own Chrome download is **blocked** (`Error: should have downloaded browser`).
  `remotion.config.ts` already points it at `/Applications/Google Chrome.app`. Renders work.
  Do not try to `remotion browser ensure`.
- A **zod version warning** is printed on every Remotion command (workspace has 3.25.76,
  Remotion wants 3.22.3). It is harmless — we use no Remotion zod schemas — and pinning it
  would break `packages/mcp`. **Ignore it; do not "fix" it.**
- `iconutil` and `sips` are present, so `.icns` and resized PNGs need no extra tooling.
  `ffmpeg` is NOT installed; Remotion bundles its own encoder, so render video via Remotion.
- The `.app` has **no icon today** (`CFBundleIconFile` absent). Wiring one in is real work.
- `vercel` CLI is installed. The GitHub remote is `git@github.com:rioukkevin/localhost-aliases.git`.

## Brand

`packages/assets/src/brand.ts` is the single source of colour truth, copied from the dashboard's
`globals.css`. `packages/assets/src/Mark.tsx` is the product mark — a patch jack with a cable
leaving it — lifted verbatim from the dashboard's `AppMark`. **Every asset derives from these.**
Never hardcode a hex; never redraw the mark.

## Frozen composition registry

`packages/assets/src/Root.tsx` imports exactly three fragments. Do not edit `Root.tsx`,
`brand.ts`, `Mark.tsx`, `index.ts` or `remotion.config.ts`.

| Directory | Export | Owner |
|---|---|---|
| `src/icon/index.tsx` | `IconCompositions()` | icon agent |
| `src/web/index.tsx`  | `WebCompositions()`  | web-icons agent |
| `src/hero/index.tsx` | `HeroCompositions()` | hero agent |

## Asset output paths (frozen — consumers depend on them)

```
packages/assets/out/
├── icon/AppIcon.icns            -> apps/tray/Resources/AppIcon.icns   (committed)
├── icon/icon-1024.png           -> reference / store listing
├── web/favicon.ico              -> packages/site/public/favicon.ico
├── web/icon-{16,32,192,512}.png -> packages/site/public/
├── web/apple-touch-icon.png     -> packages/site/public/   (180x180)
├── web/maskable-512.png         -> packages/site/public/
├── og/og.png                    -> packages/site/public/og.png        (1200x630)
└── hero/hero.mp4, hero.webm, hero-poster.png -> packages/site/public/
```

`packages/assets/scripts/sync.ts` copies `out/` into those consumers. Rendered assets ARE
committed — see "Remotion is LOCAL-ONLY" below. CI never renders anything.

## Remotion is LOCAL-ONLY (hard rule)

The asset pipeline never runs in CI. No workflow may install Remotion, download a browser,
render a still or a video, or depend on `packages/assets` in any way.

Why: rendering needs a real Chrome, it is slow, and its output is deterministic artwork that
changes only when a human decides the brand changed. CI's job is to build, sign, notarise and
publish the app — not to redraw the icon.

Consequences, all enforced:
- **Rendered assets are committed to the repo**: `apps/tray/Resources/AppIcon.icns`,
  `packages/site/public/*` (icons, `og.png`, hero video + poster + static fallback).
- `make bundle` and the site build consume those committed files and MUST work on a machine with
  no Remotion installed and no browser available.
- `packages/assets` is excluded from CI installs and from any workflow's dependency graph. If a
  workflow greps for changed packages, `packages/assets` is skipped.
- Regenerating assets is a deliberate local step: `bun run --cwd packages/assets render:all`
  followed by `sync.ts`, then commit the result. Document that in docs/RELEASE.md.
- A CI job that fails because an asset is missing is a signal that someone forgot to commit a
  render — not a reason to add a render step.

## Blob release manifest (frozen — CI writes it, the site reads it)

Uploaded with `addRandomSuffix: false` so the URL is stable:
`${NEXT_PUBLIC_BLOB_BASE_URL}/releases/latest.json`

```jsonc
{
  "version": "2.0.0",              // semver, no leading v
  "tag": "v2.0.0",
  "publishedAt": "2026-08-14T10:00:00.000Z",
  "notes": "markdown release notes",
  "minimumMacOS": "13.0",
  "dmg": {
    "url": "https://<store>.public.blob.vercel-storage.com/releases/LocalhostAliases-2.0.0.dmg",
    "filename": "LocalhostAliases-2.0.0.dmg",
    "size": 239075328,             // bytes
    "sha256": "abc123..."
  },
  "releases": [ /* same shape as the top level, newest first, for the changelog */ ]
}
```

The site must render correctly when this file **does not exist yet** (no release published):
show the source-build instructions instead of a broken download. That is the state today.

## Site

`packages/site`, Next.js 15 App Router + Tailwind v4, deployed to Vercel with root directory
`packages/site`. `app/globals.css` is a copy of the dashboard's tokens — the site and the app
must look like one product. Routes: `/` (landing), `/docs` and `/docs/[slug]`, `/changelog`.

Honesty rules, non-negotiable, because this page is what convinces someone to type their
password into a thing that edits `/etc/hosts` as root:
- Say plainly that project aliases are **http:// only**, and why (a raw TCP forwarder never sees
  the bytes, so nothing can terminate TLS).
- Say what runs as root, when, and that nothing is permanently installed.
- Never claim notarization/signing that has not happened. There is no auto-update either: a new
  build is a download the reader chooses, and the changelog is how they learn one exists.
- Every example hostname ends in `.test`. `.local` is refused by the app (see
  [docs/TLD.md](TLD.md)) and so are the HSTS-preloaded TLDs, so an example using one teaches a
  name the product will reject — the site's copy is the first place that rot shows up.

## Env vars

| Var | Where | Purpose |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | GitHub secret | CI uploads the DMG + manifest |
| `NEXT_PUBLIC_BLOB_BASE_URL` | Vercel env | public base the site reads the manifest from |
| `REMOTION_BROWSER` | local | override the Chrome used for rendering |
