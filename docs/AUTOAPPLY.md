# Automatic apply — design

Today a dashboard mutation only writes the desired state; the user then clicks "Prepare and
apply", which asks the tray to raise the admin prompt. That second click is redundant: nobody
adds an alias in order to *not* use it. Adding an alias should make it live.

## What can and cannot be automatic

The distinction already exists in `diffDesiredState` and is the whole basis of this feature:

| Change | Needs root? | Behaviour |
|---|---|---|
| target **port** of an existing alias | no | the forwarder watches `routes.json` and retargets itself. **Fully automatic, no prompt, already works.** |
| **enable/disable**, description, project link | no | config only; no system state involved |
| **add** or **delete** an alias | yes | new hostname in `/etc/hosts` + new `lo0` address |
| **rename**, or a TLD change | yes | hostnames change |

So "apply automatically" means: after a mutation that needs root, the dashboard queues the
privileged request **itself**, and the macOS password dialog appears without a second click.

## Rules

1. **Coalesce.** Adding three aliases in quick succession must raise **one** prompt, not three.
   Debounce ~1.5s of quiet after the last mutation, then queue a single request. The apply is a
   full idempotent desired-state reconcile, so one prompt always covers everything pending.
2. **Never loop on cancel.** If the user dismisses the dialog, do **not** re-queue. Enter a
   `deferred` state: the drift banner stays, the status indicator shows work pending, and the
   next attempt only happens on an explicit user action or a later mutation. A password dialog
   that reappears because you dismissed it is malware behaviour.
3. **Never prompt without a visible cause.** Only a user-initiated mutation may trigger an
   automatic apply. Polling, a reboot, drift discovered at launch, or a request replay must never
   raise a dialog on their own — they surface the banner and wait.
4. **Tray down = no queue.** If the heartbeat is stale, skip queuing (nothing would read it) and
   show the existing "menu-bar app is not running" state.
5. **One in flight.** While a privileged operation is running, further mutations mark state dirty
   and are picked up by the next apply rather than queuing a second prompt.
6. **Honest UI throughout.** Mutating rows show "waiting for the admin prompt…", then live. A
   failure shows the real error, not a generic one. The alias itself is already saved either way —
   config is persisted before any apply, and that must not change.

## Setting

`config.autoApply`, default **true**. When false the product behaves exactly as it does today
(write desired state, wait for an explicit click). Exposed in the settings drawer with a plain
explanation: *"Changes are applied as soon as you make them. Turn this off if
you would rather batch changes and apply them yourself."*

## Where it lives

The debounce/coalesce logic belongs in the **dashboard service layer**, next to the code that
already decides `needsPrompt` — not in the UI (it would break on navigation) and not in the tray
(it does not know why state changed). The tray keeps its single job: watch the request file,
raise one prompt, write the result.

## Acceptance

- Adding an alias raises exactly one prompt with no extra click, and the alias resolves after it.
- Adding three aliases within a second raises exactly one prompt.
- Changing only a port raises **no** prompt and retargets within the forwarder's poll.
- Dismissing the prompt leaves the alias saved, shows the deferred state, and does not re-prompt.
- With `autoApply` off, behaviour is byte-for-byte today's.
- With the tray not running, nothing is queued and the existing banner explains why.
