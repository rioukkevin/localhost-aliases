# DESIGN.md — the dashboard's visual language

Rebuild brief. Everything below is the *entire* preserved design of the web dashboard
(`packages/web`). Stack assumed: Next.js App Router + React 19 + Tailwind **v4** (CSS-first
config via `@theme inline`, no `tailwind.config.js`).

The metaphor is a **studio patchbay**: flat, instrument-panel surfaces; hairline rules instead
of shadows; square corners (2px radius max); one acid-lime accent; hostnames and ports set in
monospace as the hero content; a dashed "patch cable" linking a name to a port, which drifts
only while the upstream is answering.

Non-negotiables:
- No literal hex in components — every colour comes from a token.
- No card shadows, no rounded cards. Containers are `border border-hairline` on a flat surface.
- No icon library. All icons are hand-drawn 16×16, stroke 1.4.
- Dark is the default surface; light is a full re-theme, not a tint.

---

## 1. Tokens (verbatim)

`app/globals.css`, top of file. Dark = `:root`; light = a `prefers-color-scheme` override.
There is no manual theme toggle — the app follows the OS (`colorScheme: "dark light"` in the
Next `viewport` export).

```css
:root {
  --canvas: #0a0a0b;
  --raised: #111113;
  --sunken: #060607;
  --hairline: rgba(255, 255, 255, 0.08);
  --hairline-strong: rgba(255, 255, 255, 0.16);
  --ink: #f2f2ef;
  --muted: #8a8a85;
  --faint: #55554f;
  --accent: #d6ff4b;
  --accent-ink: #0a0a0b;
  --accent-dim: rgba(214, 255, 75, 0.14);
  --live: #4ade80;
  --down: #f5a524;
  --danger: #ff6b5a;
  --shadow: 0 1px 0 rgba(255, 255, 255, 0.03);
}

@media (prefers-color-scheme: light) {
  :root {
    --canvas: #fafaf8;
    --raised: #ffffff;
    --sunken: #f1f1ed;
    --hairline: rgba(0, 0, 0, 0.1);
    --hairline-strong: rgba(0, 0, 0, 0.2);
    --ink: #111112;
    --muted: #6b6b66;
    --faint: #a3a39c;
    --accent: #5b7a00;
    --accent-ink: #ffffff;
    --accent-dim: rgba(91, 122, 0, 0.1);
    --live: #16a34a;
    --down: #b45309;
    --danger: #dc2626;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  }
}
```

Semantics:

| Token | Role |
| --- | --- |
| `canvas` | page ground; also the ground of `Panel` / `AliasList` bodies |
| `raised` | one step up: panel header strips, banners, toasts, row hover |
| `sunken` | one step down: input fields, code blocks, group headers, nav active pill, skeletons |
| `hairline` | default border for *every* element |
| `hairline-strong` | deliberate edges: input borders, outline buttons, dialog border |
| `ink` / `muted` / `faint` | primary / secondary / tertiary text (`faint` also = labels, punctuation, TLD suffix) |
| `accent` | the single brand colour: primary button fill, focus ring, active nav tick, selection |
| `accent-ink` | text on accent fill |
| `accent-dim` | accent at low alpha — only the Toggle's on-track uses it |
| `live` / `down` | upstream answering / nothing listening (status dots, cables, chips) |
| `danger` | destructive text and edges, error toasts/banners |
| `shadow` | defined but essentially unused; the design is shadow-free (`shadow-sm` appears only on ToastCard) |

## 2. Tailwind v4 `@theme` mapping

```css
@theme inline {
  --color-canvas: var(--canvas);
  --color-raised: var(--raised);
  --color-sunken: var(--sunken);
  --color-hairline: var(--hairline);
  --color-hairline-strong: var(--hairline-strong);
  --color-ink: var(--ink);
  --color-muted: var(--muted);
  --color-faint: var(--faint);
  --color-accent: var(--accent);
  --color-accent-ink: var(--accent-ink);
  --color-accent-dim: var(--accent-dim);
  --color-live: var(--live);
  --color-down: var(--down);
  --color-danger: var(--danger);

  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
```

That yields `bg-canvas`, `text-ink`, `border-hairline-strong`, `divide-hairline`,
`border-live/40`, etc. There is no custom spacing/radius scale — sizes are Tailwind defaults
plus arbitrary values (`text-[13px]`, `rounded-[2px]`, `w-[11rem]`).

### Base rules that must survive the rebuild

```css
/* Default border colour for every element. It MUST live in @layer base: an
   unlayered rule outranks Tailwind's utility layer, which would silently make
   every `border-*` colour utility (border-danger, border-accent, …) inert. */
@layer base {
  * {
    border-color: var(--hairline);
  }
}

html,
body {
  background: var(--canvas);
  color: var(--ink);
}

body {
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

::selection {
  background: var(--accent);
  color: var(--accent-ink);
}
```

## 3. Typography

Two families only. System sans for prose and chrome; mono for anything machine-literal.

```css
/* Hostnames and ports are the hero content: monospace, tight, deliberate. */
.mono {
  font-family: var(--font-mono);
  font-feature-settings: "ss01", "zero";
  letter-spacing: -0.02em;
}
```

`.mono` is applied to: hostnames, TLD suffixes, ports, URLs, file paths, shell commands,
JSON/TOML snippets, all `TextField` inputs and their prefix/suffix, `<select>` in the alias
editor, panel `meta` counts, status-strip readings, the wordmark, the nav footer note.

Type scale actually used (px, all explicit — no reliance on Tailwind's named sizes except
`text-sm`/`text-xs` inside Toast):

| Size | Use |
| --- | --- |
| 26 / 22 md↕ | `PageHeader` h1 (`text-[22px] md:text-[26px]`, `font-semibold tracking-tight`) |
| 19 / 17 | alias hostname in `AliasRow` (mono, `font-medium leading-tight`) |
| 17 / 15 | alias port in `AliasRow` (mono, right-aligned) |
| 15 | `TextField` input text; `AliasMini` hostname/port; `EmptyState` title (sans, semibold) |
| 14 | `ConfirmDialog` title |
| 13 | body/lede text, `Button` md, nav items, Toggle label |
| 12.5 | banner + dialog body copy |
| 12 | `Button` sm, `CopyButton` withLabel, `CodeBlock`, status-strip value, group name |
| 11 | field messages, secondary mono lines (alias URL), counts, Toggle hint, StatusDot label |
| 10 | all-caps labels: panel titles, field labels, `Chip`, status-strip labels, nav footer |

All-caps label recipe (three near-identical variants; keep them):
`text-[10px] font-medium uppercase tracking-[0.16em] text-faint` — panel/rack headers use
`tracking-[0.18em]`, `Chip` uses `tracking-[0.14em]`.

## 4. The patchbay and `PatchCable`

An alias *is* a patch cable: a resolvable name on the left, the port your dev server already
listens on at the right. The list of aliases is a **rack**: a `border-hairline` section, a
"PATCHBAY" rack-label strip on top with the alias/live count and a `Port` column legend, then
one recessed `bg-sunken` group header per project folder, then rows separated by
`divide-y divide-hairline`. Rows hover to `bg-raised`.

`PatchCable` (`components/PatchCable.tsx`) — reproduce exactly; the geometry trick matters:

```tsx
/**
 * It scales by using percentage geometry instead of a viewBox, so the dash
 * pattern, the jack radii and the stroke weight stay pixel-constant at every
 * container width — a viewBox with preserveAspectRatio="none" would smear them.
 *
 * The `<g transform="translate(-INSET)">` wrapper is the trick that makes the
 * right jack sit INSET px from the right edge: percentages inside a group still
 * resolve against the viewport, so the translate just shifts the resolved point.
 */
const INSET = 9;

export function PatchCable({ status, size = "row", className = "" }: PatchCableProps) {
  const live = status === "up";
  const height = size === "figure" ? 40 : 28;   // "row" = 28, "figure" = 40
  const mid = height / 2;

  // One colour drives cable + jacks so the whole connector reads as one object.
  const tone = live ? "text-live" : status === "down" ? "text-down" : "text-faint";
  const cableOpacity = live ? 1 : 0.45;

  return (
    <svg className={`block w-full ${tone} ${className}`} height={height}
         role="presentation" aria-hidden="true" focusable="false">
      {/* left jack: ring + pin */}
      <circle cx={INSET} cy={mid} r="5.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <circle cx={INSET} cy={mid} r="2" fill="currentColor" />

      <g transform={`translate(${-INSET},0)`}>
        <line x1={INSET * 2} y1={mid} x2="100%" y2={mid}
              stroke="currentColor" strokeWidth="1.25" strokeDasharray="6 6"
              strokeLinecap="round" opacity={cableOpacity}
              className={live ? "cable-live" : ""} />
        {/* right jack */}
        <circle cx="100%" cy={mid} r="5.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.55" />
        <circle cx="100%" cy={mid} r="2" fill="currentColor" />
      </g>
    </svg>
  );
}
```

Props: `status: "up" | "down" | "unknown"`, `size?: "row" | "figure"` (default `"row"`),
`className?`. It animates **only** when `status === "up"`.

```css
/* The patch cable: a dashed connector that drifts only while the upstream is up. */
@keyframes cable-drift { to { stroke-dashoffset: -24; } }
.cable-live { animation: cable-drift 1.4s linear infinite; }

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
.dot-live { animation: pulse-dot 2.4s ease-in-out infinite; }
```

`AppMark` is the same idiom shrunk to a logo — a jack with a cable leaving it, 22×22,
`stroke-width 1.2`, ring at `opacity 0.55`, rendered `text-accent`:

```tsx
<circle cx="7" cy="11" r="5.5" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
<circle cx="7" cy="11" r="2" fill="currentColor" />
<path d="M12.5 11h3.2a2.3 2.3 0 0 0 2.3-2.3V4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
<circle cx="18" cy="3" r="1.6" fill="currentColor" />
```

**Row layout (the one composition worth preserving).** `AliasRow` is a flex-wrap `<li>`,
`px-4 py-4 md:px-8`, with explicit `order-*` classes so the cable drops to its own line below
`sm` while the hostname keeps full width:

- order-1 `StatusDot` (shrink-0, `title` = human status note)
- order-2 hostname block, `flex-1 lg:w-[22rem] lg:flex-none`; name in `text-ink`, TLD suffix in
  `text-faint`; second line = URL in `mono text-[11px] text-faint`
- order-4→sm:order-3 `PatchCable`, `basis-full pl-[1.9rem] sm:basis-0 sm:pl-0`
- order-5→sm:order-4 port, `w-[4.5rem] text-right`, colon in `text-faint`
- order-3→sm:order-5 action cluster, `w-[11rem] justify-end gap-0.5` (copy, open, detach, edit, delete)

The rack header repeats `w-[4.5rem]` and `w-[11rem]` spacers so the "Port" legend sits exactly
above the port column. `AliasMini` is the read-only version of the same row at 15px with a
narrower action cluster (`w-[4.25rem]`, or `w-[6.5rem]` with detach).

Empty-state figure: a literal demo cable — `myapp` + `.local` in faint, a `size="figure"`
cable at `status="up"`, then `:3000`.

## 5. Primitives

### Button (`Button.tsx`)
Props: `variant?: "primary" | "outline" | "ghost" | "danger"` (default `outline`),
`size?: "sm" | "md"` (default `md`), `busy?: boolean`, plus all `ComponentProps<"button">`
(so React 19 `ref` passes through `...rest`). `busy` disables and prepends the spinner and
sets `aria-busy`.

```ts
const VARIANTS = {
  primary: "bg-accent text-accent-ink border border-accent hover:opacity-85",
  outline: "border border-hairline-strong text-ink bg-transparent hover:bg-sunken",
  ghost:   "border border-transparent text-muted hover:text-ink hover:bg-sunken",
  danger:  "border border-hairline-strong text-danger bg-transparent hover:bg-sunken",
};
const SIZES = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5",
  md: "h-9 px-3.5 text-[13px] gap-2",
};
// base: inline-flex select-none items-center justify-center rounded-[2px] font-medium
//       transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40
```

`Spinner` — the only spinner in the app: 12×12, a 25%-opacity ring plus a quarter arc
(`d="M6 1.5A4.5 4.5 0 0 1 10.5 6"`), `strokeWidth 1.4`, `animate-spin`.

`IconButton` — square icon-only affordance, props `label` (required, becomes `aria-label` +
`title`), `tone?: "default" | "danger"`:
`h-8 w-8 rounded-[2px] border border-transparent text-muted`, hover →
`hover:border-hairline hover:text-ink` (danger: `hover:text-danger`).

### TextField (`TextField.tsx`)
Props: `label` (required), `hint?: ReactNode`, `error?: string | null`,
`warning?: string | null`, `prefix?`, `suffix?`, `hideLabel?`, `fieldClassName?`, plus
`ComponentProps<"input">` minus `size`/`prefix`.

- Label: `text-[10px] font-medium uppercase tracking-[0.16em] text-faint`, or `sr-only` when
  `hideLabel`.
- Field shell: `flex h-10 items-center gap-0 border bg-sunken px-0 transition-colors`,
  border `border-hairline-strong`, or `border-danger` when `error`.
- **The focus ring lives on the wrapper, not the input**, so it never paints over prefix/suffix:
  `has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent`,
  and the input itself carries `focus-visible:outline-none`.
- Input: `mono min-w-0 flex-1 bg-transparent px-2.5 text-[15px] text-ink placeholder:text-faint`.
- Prefix/suffix: `mono … text-[15px] text-faint`, `aria-hidden` (e.g. `:` before a port,
  `.local` after a name).
- One message slot, precedence `error ?? warning ?? hint`, `text-[11px] leading-snug`,
  coloured `text-danger` / `text-down` / `text-faint`; `role="alert"` and `aria-invalid` only
  for errors; wired with `aria-describedby`.

### Toggle (`Toggle.tsx`)
Props: `checked`, `onChange(next)`, `label`, `hint?`, `disabled?`, `hideLabel?`.
A real `<button role="switch" aria-checked>`, space/enter operable.
Track: `relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors`,
on = `border-accent bg-accent-dim`, off = `border-hairline-strong bg-sunken`, disabled =
`opacity-40`. Knob: `h-3 w-3 rounded-full transition-transform duration-150`, on =
`translate-x-[19px] bg-accent`, off = `translate-x-[3px] bg-faint`. Label `text-[13px] text-ink`
with optional hint `text-[11px] text-muted`. The pill is the only rounded-full element besides
dots.

### Toast (`Toast.tsx`)
`ToastProvider` + `useToast()` → `{ push({tone, title, detail?}), dismiss(id) }`.
Tones `"info" | "success" | "error"`. Auto-dismiss after **6000 ms**; at most the last 4 are
kept (`[...current.slice(-3), next]`).

Region: `pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6`,
`aria-live="polite"` (each error card additionally carries `role="alert"`; others `role="status"`).

Card: `pointer-events-auto flex w-full max-w-sm items-stretch border border-hairline bg-raised text-sm shadow-sm`,
led by a 3px tone bar — `info: bg-muted`, `success: bg-live`, `error: bg-danger` — then
`px-3 py-2.5` with title `font-medium text-ink` and optional detail
`text-xs leading-relaxed text-muted`, then a `×` dismiss button (12×12 stroke-1.5 path,
`text-muted hover:text-ink`).

### StatusDot (`StatusDot.tsx`)
"A jack-lamp: a dot inside a hairline ring, pulsing only when the upstream is up."
Props: `status: "up"|"down"|"unknown"`, `withLabel?`, `className?`.

```ts
const TONE = {
  up:      { dot: "bg-live",  ring: "border-live/40",         text: "listening" },
  down:    { dot: "bg-down",  ring: "border-down/40",         text: "no server" },
  unknown: { dot: "bg-faint", ring: "border-hairline-strong", text: "unknown"   },
};
```
Ring `h-3.5 w-3.5 rounded-full border`; inner dot `h-1.5 w-1.5 rounded-full`, plus `dot-live`
when up. The label is `text-[11px] text-muted` or `sr-only`. Exposes `data-status`.

### CopyButton (`CopyButton.tsx`)
Props: `value`, `what?` (default `"value"`, used in the a11y label), `withLabel?`, `className?`.
Copies, flips to a check for **1600 ms**, label swaps `Copy {what}` → `Copied {what}`, icon
swaps `IconCopy` → `IconCheck className="text-live"`. Icon-only mode renders an `IconButton`;
`withLabel` mode renders `h-8 … border border-hairline-strong px-2.5 text-[12px] text-muted hover:text-ink`
with the word "Copy"/"Copied".

### EmptyState (`EmptyState.tsx`)
Props: `title`, `children`, `figure?` (illustration slot — the aliases view puts a demo patch
cable here), `actions?`.
`flex flex-col items-center gap-6 px-6 py-14 text-center`; figure capped `max-w-lg`; copy block
`max-w-md`; title `text-[15px] font-semibold tracking-tight text-ink`; body
`mt-2 text-[13px] leading-relaxed text-muted`; actions `flex flex-wrap justify-center gap-2`.

### Banner (`Banner.tsx`)
Props: `tone?: "info" | "warn" | "danger"` (default info), `title`, `children`, `actions?`.
"Full-width notice with a coloured edge. Flat, hairline, no card shadow."
`flex items-stretch border border-hairline bg-raised` + a 3px bar
(`info: bg-accent`, `warn: bg-down`, `danger: bg-danger`); body `px-4 py-3.5`; header row is
`IconAlert` in the tone colour + `text-[13px] font-semibold tracking-tight text-ink`; copy
`mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-muted`; actions `mt-3 flex flex-wrap gap-2`.
`role="alert"` when danger, else `role="status"`.
The canonical instance (`HelperBanner`) puts a whole command box in `actions`: a
`border-hairline-strong bg-sunken` strip with `mono text-[12px]` code and a `withLabel`
CopyButton floated inside at `m-1 border-0 bg-transparent`.

### ConfirmDialog (`ConfirmDialog.tsx`)
Props: `open`, `title`, `children`, `confirmLabel?` ("Confirm"), `cancelLabel?` ("Cancel"),
`tone?: "danger"|"default"`, `busy?`, `size?: "sm"|"md"` (`max-w-sm` / `max-w-xl`),
`onConfirm`, `onCancel`. Hand-rolled, not `<dialog>` (identical SSR output).
Overlay `fixed inset-0 z-40 flex items-center justify-center p-4` over
`absolute inset-0 bg-canvas/80 backdrop-blur-[2px]` (click = cancel).
Panel: `relative flex max-h-[80vh] w-full flex-col border border-hairline-strong bg-raised p-5`,
`role="dialog" aria-modal aria-label={title}`; title `text-[14px] font-semibold tracking-tight`;
scrollable body `text-[12.5px] leading-relaxed text-muted`; footer `mt-5 flex justify-end gap-2`
with a `ghost` Cancel and a `primary`/`danger` Confirm (`size="sm"`).
Behaviour: autofocus the confirm button, Escape cancels, Tab cycles within the panel's buttons
(minimal trap), focus restored to the previously active element on close.

### Panel (`Panel.tsx`)
"The one container shape in the app." Props: `title` (rack label, uppercase), `meta?`
(quiet count, mono), `aside?` (pushed right), `children`, `footer?`, `padded?` (default true;
`false` for full-bleed lists that pad their own rows), `className?`.

```tsx
<section className="border border-hairline bg-canvas">
  <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-raised px-4 py-2.5 md:px-6">
    <h2 className="text-[10px] font-medium uppercase tracking-[0.18em] text-faint">{title}</h2>
    {meta && <span className="mono text-[11px] text-muted">{meta}</span>}
    {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
  </header>
  <div className={padded ? "px-4 py-5 md:px-6" : ""}>{children}</div>
  {footer && <div className="border-t border-hairline px-4 py-3.5 md:px-6">{footer}</div>}
</section>
```

### Chip (`Chip.tsx`)
"A state label. Deliberately square and hairline — not a pill badge."
Props: `tone?: "live"|"down"|"accent"|"muted"` (default muted), `dot?`, `children`.

```ts
const TONE = {
  live:   { text: "text-live",   border: "border-live/40",       dot: "bg-live"  },
  down:   { text: "text-down",   border: "border-down/40",       dot: "bg-down"  },
  accent: { text: "text-accent", border: "border-accent/40",     dot: "bg-accent"},
  muted:  { text: "text-muted",  border: "border-hairline-strong", dot: "bg-faint"},
};
// inline-flex items-center gap-1.5 whitespace-nowrap rounded-[2px] border px-2 py-[3px]
// text-[10px] uppercase tracking-[0.14em]
```
Optional leading lamp: `h-1.5 w-1.5 rounded-full`.

### PageHeader / PageBody (`PageHeader.tsx`)
`PageHeader({title, children})` → `<header class="mb-7">` with
`h1.text-[22px] md:text-[26px] font-semibold tracking-tight text-ink` and a lede
`mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted`.
`PageBody` is the shared column: `mx-auto w-full max-w-5xl px-4 py-8 md:px-8 md:py-10`.
Every view uses both so the four pages cannot drift typographically.

### NavRail (`NavRail.tsx`)
One element, two layouts (no duplicated markup — duplicate `data-testid`s would make every e2e
selector ambiguous): a sticky horizontal bar under 1024px, a fixed 14rem (`lg:w-56`) left rail
above it; the shell offsets with `lg:pl-56`.

```
sticky top-0 z-30 flex items-center gap-4 border-b border-hairline bg-canvas px-4 py-3
lg:fixed lg:inset-y-0 lg:left-0 lg:w-56 lg:flex-col lg:items-stretch lg:gap-8
lg:border-b-0 lg:border-r lg:px-4 lg:py-6
```
Brand: `AppMark className="text-accent"` + wordmark
`mono text-[13px] font-medium tracking-tight` reading `localhost` + `-` in `text-faint` +
`aliases` (hidden below `sm`).
Items (Aliases `/`, Projects, Settings, MCP): `rounded-[2px] px-2.5 py-2 text-[13px]`, inactive
`text-muted hover:bg-sunken hover:text-ink`, active `bg-sunken text-ink` + `aria-current="page"`
plus a 2px accent tick — bottom edge on mobile (`absolute inset-x-2.5 bottom-0 h-[2px]`),
left edge on desktop (`lg:left-0 lg:top-1/2 lg:h-4 lg:w-[2px] lg:-translate-y-1/2`).
Footer note, desktop only: `mono text-[10px] leading-relaxed text-faint` reading
`127.0.0.1` / `names → ports`.

### StatusStrip (`StatusStrip.tsx`)
Global instrument readout under the nav, inside the shell so every view shows it.
`border-b border-hairline bg-raised`, inner row uses the *same* `max-w-5xl px-4 md:px-8` as
`PageBody` so readings align with the content column: `flex flex-wrap items-center gap-x-7 gap-y-2 py-2.5`.
Four readings — `helper`, `scheme`, `tld`, `aliases`. Each is
`label` (`text-[10px] uppercase tracking-[0.16em] text-faint`) + `value`
(`mono text-[12px] text-ink`) baseline-aligned, with an optional 1.5px lamp
(`live: bg-live` + `dot-live`, `down: bg-down`, `faint: bg-faint`).
Values: helper = `running` / `stopped` / `not installed` / `unreachable` / `…`;
scheme = `http:PORT` or `https:PORT`; tld = `.local`; aliases = count. `…` while unloaded.

### Icons (`Icons.tsx`)
No icon library. Every icon shares one wrapper: 16×16, `viewBox="0 0 16 16"`, `fill="none"`,
`stroke="currentColor"`, `strokeWidth="1.4"`, round caps/joins, `aria-hidden`, `focusable=false`
— "so they sit at the same optical weight as the hairlines." Set: Copy, Check, External, Trash,
Pencil, Plus, Close, Alert, Folder (and any others follow the same grid).

### CodeBlock (`CodeBlock.tsx`)
Props: `value`, `what?`, `label?`. Optional caption in the 10px caps style, then
`flex items-stretch border border-hairline-strong bg-sunken` with
`pre.mono.whitespace-pre-wrap.break-words.px-3.py-2.5.text-[12px].leading-relaxed.text-ink`
(pre-wrap, not pre — "a silently clipped command is a broken command") and a `withLabel`
CopyButton at `m-1 shrink-0 self-start border-0 bg-transparent`.

## 6. Interaction rules

**Focus ring — one treatment for the whole app, always visible, never removed:**

```css
/* Layered for the same reason as the border rule: a component that moves the
   ring onto a wrapper (TextField) must be able to opt its inner input out. */
@layer base {
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
}
```

**Reduced motion — global kill switch:**

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
```

**Skip link** in the layout: `sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-accent focus:bg-raised focus:px-3 focus:py-2 focus:text-[13px]`
→ `#content`.

**Motion budget:** three animations only — `cable-drift` (1.4s linear, live cables),
`pulse-dot` (2.4s ease-in-out, live lamps), `animate-spin` (busy). Everything else is
`transition-colors duration-150`.

**Polling / pause.** `POLL_MS = 5000`, one shared timer per document (`useSyncExternalStore`
store, not per-component polls). The poll **stops while `document.hidden`** and refreshes
immediately on `visibilitychange` back to visible. Every successful mutation invalidates the
status through a bus so the strip updates at once. Requests are single-flighted. A failed read
keeps the last good data on screen and only flips `reachable` — **the UI dims rather than
empties**.

**Optimistic mutations.** Create/update/delete/move apply to local state first (a create gets a
temporary `pending-…` id, whose row disables Edit/Delete), then reconcile with a background
refresh. On failure the previous snapshot is restored and an error toast explains why.

**Loading skeleton** (list, first load only): two rows of `bg-sunken` blocks matching the row
rhythm — `h-3.5 w-3.5 rounded-full`, `h-4 w-40`, a `h-px flex-1 bg-hairline` standing in for the
cable, `h-4 w-10` — inside `<ul aria-busy="true">`.

**Busy affordances.** Buttons take `busy` (spinner + disabled). The patchbay header shows an
inline `Spinner` + `applying…` in `text-accent text-[11px]` with `role="status"` while writes
are in flight.

**Toast patterns** (the app's only transient feedback; never used for validation):
- success — `"{hostname} patched to :{port}"`, `"{hostname} updated"`, `"{hostname} unpatched"`,
  `"{hostname} moved to {folder}"` / `"detached from {folder}"`.
- info — a success that came back with a server `warning`; the warning goes in `detail`.
- error — `"Change rejected"`, `"Install failed"`, `"Could not write the workspace file"`,
  with the error message in `detail`.
Title = what happened, in the app's own vocabulary (*patched*, *unpatched*, *detached*);
`detail` = the machine text (path, warning, error). Field-level problems stay in `TextField`
`error`/`warning`; system-level problems become a `Banner`; destructive actions get a
`ConfirmDialog` first ("Unpatch {hostname}?" → "Delete alias").

**Voice.** Lowercase, mechanical, reassuring about what is *not* touched: "listening",
"no server", "nothing is listening on this port", "Nothing patched yet", "no folder — these
aliases belong to nothing", "Your dev server on port 3000 is not touched."
