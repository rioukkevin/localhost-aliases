# The TLD — why `.test`, and which TLDs are refused

Every alias is `<name>.test`. `.test` is the default. Three families of TLD are rejected by
validation and never offered in the UI: `.local`, the HSTS-preloaded TLDs (`.dev`, `.app`,
`.page` and friends), and `.localhost`. The rules live in `packages/core/src/tld.ts`, one list
per reason, and each rejection carries its own message — told only "not allowed", a developer
just tries the next broken suffix.

This page exists so the rule can be checked rather than believed. Every number below was
measured on a developer Mac (macOS 26.3, Apple Silicon) with the commands printed beside it.

## `.test` is the reserved name for exactly this

[RFC 6761 §6.2](https://www.rfc-editor.org/rfc/rfc6761#section-6.2) reserves `.test` for
testing and development. The consequences are the three properties an alias needs:

- it is never delegated to a registry, so it can never collide with a real domain you might
  one day need to reach;
- it is never publicly resolvable, so a leaked hostname cannot point anyone anywhere;
- nothing on macOS claims it, so the `/etc/hosts` entry is simply the answer, immediately.

## `.local` is not supported

`.local` is reserved for multicast DNS by
[RFC 6762 §3](https://www.rfc-editor.org/rfc/rfc6762#section-3). On macOS, `mDNSResponder`
owns that suffix: a lookup for any `.local` name is put to the network as a multicast query,
and the resolver waits out that query before it answers. The wait is roughly five seconds.

That is the whole reason. It is not the `/etc/hosts` block, not the loopback addresses, and not
the forwarder.

### The measurement

`getaddrinfo` is the call every client makes — `curl`, your browser, your test runner. Timing it
directly separates name resolution from everything the app does:

```sh
bun -e '
const dns = require("node:dns");
for (const n of ["index.local", "nope-xyz.local", "nope-xyz.test", "broadcasthost"]) {
  const t = Bun.nanoseconds();
  await new Promise((r) => dns.lookup(n, () => r()));
  console.log(n.padEnd(16), ((Bun.nanoseconds() - t) / 1e9).toFixed(3) + "s");
}'
```

| name             | in `/etc/hosts`? | `getaddrinfo` |
| ---------------- | ---------------- | ------------- |
| `index.local`    | yes              | 5.008s        |
| `nope-xyz.local` | **no**           | 5.006s        |
| `nope-xyz.test`  | no               | 0.003s        |
| `broadcasthost`  | yes              | 0.003s        |

The two `.local` rows are the finding. A name that is *not* in the hosts file costs the same
five seconds as one that is, so the delay cannot be caused by anything we wrote there — the
**suffix** is what costs. `broadcasthost` is the control: a hosts-file lookup with no special
suffix returns in microseconds.

The `index.local` row was taken while the machine still had a `.local` managed block installed,
from a build made before this decision. You do not need one to check the claim: the
`nope-xyz.*` rows resolve nowhere at all and already show the five seconds, which is the point.

### The same thing through the whole stack

Timed against a live alias on the same machine (again, a `.local` one from before the decision),
so the split between resolution and everything else is visible:

```sh
curl -o /dev/null -s -w 'dns=%{time_namelookup}s connect=%{time_connect}s ttfb=%{time_starttransfer}s\n' \
  http://index.local
```

```
dns=5.004571s  connect=5.004800s  ttfb=5.009508s
```

Resolution takes 5.005s; the TCP connect adds 0.23ms on top of it and the first byte arrives
4.7ms after that. The same dashboard fetched by address — `curl http://127.0.0.2` — answers in
`dns=0.000637s ttfb=0.004545s`. So the forwarder and the dashboard are ~4ms end to end, and the
five seconds is entirely name resolution. Nothing else needed optimising.

### To be precise about it

`.local` is not broken, and Apple has not deprecated it. Bonjour resolves the names it actually
owns quickly, and that is what the suffix is for — printers, AirPlay receivers, machines
advertising themselves on a LAN. It is the wrong carrier for a name whose answer is a static
line in `/etc/hosts`, because reaching that answer means waiting out a multicast query that will
never be relevant. So the product does not offer it.

## HSTS-preloaded TLDs are refused too

Project aliases are `http://` only, and that is structural: the forwarder splices raw bytes and
never parses a request, so there is nothing in the path that could present a certificate. (See
[V2.md](V2.md).)

Some whole TLDs are on the Chromium HSTS preload list as include-subdomains entries — the
Google-operated gTLDs (`.dev`, `.app`, `.page`, `.new`, `.zip`, `.mov`, `.foo`, `.gle`,
`.google`, …) plus `.gay`. That list ships inside Chrome, Edge and Safari, so for a name under
one of them the browser rewrites `http://` to `https://` **before any request leaves the
machine**. An alias there would fail with a TLS error that says nothing about the actual cause,
so validation rejects those TLDs with the reason instead.

`HSTS_PRELOADED_TLDS` in `packages/core/src/tld.ts` is the set the app enforces. To check a
suffix yourself, open `chrome://net-internals/#hsts` and query the domain: a preloaded TLD
reports `static_upgrade_mode: FORCE_HTTPS`. The authoritative list is at
[hstspreload.org](https://hstspreload.org) and it grows, so the enforced set is a snapshot that
has to be re-checked, not a law of nature.

## `.localhost` is refused for a third reason

Not mDNS and not HSTS: macOS resolves every name under `.localhost` to `127.0.0.1` itself
([RFC 6761 §6.3](https://www.rfc-editor.org/rfc/rfc6761#section-6.3)) and never consults
`/etc/hosts`. Each alias owns its own `127.0.0.x`, so `myapp.localhost` would land on
`127.0.0.1:80` — past the forwarder, on a port nothing is listening on.

## What the dashboard offers

`test` (the default), `internal`, `lan`, `home.arpa` and `example`. Each is reserved or private
by standard, none is publicly resolvable, and all of them answer straight out of `/etc/hosts`.
Changing the TLD renames every hostname, so the next apply raises one admin prompt.

## What this means in the product

- New aliases are `<name>.test`. The dashboard's TLD field shows `test`.
- `local` is rejected by validation, with the mDNS reason.
- HSTS-preloaded TLDs are rejected by validation, with the forced-`https` reason.
- `localhost` is rejected by validation, with the "macOS answers this itself" reason.
- The last label decides: `foo.dev` is refused exactly as `dev` is, because the preload entry
  covers every name under the TLD.
- No migration flow exists, and none is planned: v2 has not shipped, so there is no installed
  base holding `.local` aliases to migrate.
