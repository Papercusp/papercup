# :3170 flaps to ERR_CONNECTION_REFUSED every ~5-7min — it's papercup-staging-sync, not load or a crash
URL: /internal/docs/agent-insights/staging-3170-flaps-every-5min-via-auto-sync-timer

The staging operator (:3170) self-restarts on its own schedule via papercup-staging-sync.timer, outside dev:restart's drain/coalesce path — a real ~10-13s hard-down window roughly every 5-7 minutes, whenever staging has advanced (near-continuous under git-sync). dev:service_health now surfaces a recentRestartNote so this is diagnosable instead of mysterious (EI-13221).

## Symptom

A session actively using the staging operator (`http://127.0.0.1:3170`) — a
`verdict` browser session, a raw `curl`, a health probe — gets a clean 200,
then moments later `ERR_CONNECTION_REFUSED` / `net::ERR_CONNECTION_REFUSED` /
a raw `fetch failed` against the exact same URL, with no code change and no
one having run `dev:restart` or `systemctl restart`. It "self-recovers" a few
seconds later. Easy to misdiagnose as load, a memory-watchdog recycle, or a
regression in whatever you were just testing.

## Root cause

`:3170` (`papercup-staging-api.service`) is NOT a static long-running process
that only restarts when a human/agent asks. Since **isolated-staging-tier-
2026-06-21**, it runs from an **isolated checkout** (`papercusp-staging`, a
sibling of the main `papercup`/`papercusp` tree — see the branch-discipline
note in the root CLAUDE.md about never editing sibling worktrees), which
**`papercup-staging-sync.timer`** auto-fast-forwards to the latest *committed*
`staging` HEAD on its own schedule:

```
OnActiveSec=5min                 # first fire
OnUnitInactiveSec=5min           # then 5min after each run FINISHES
```

Its driven service, `papercup-staging-sync.service`, runs
`apps/operator/bin/release/sync-staging-checkout.sh`, which:

1. No-ops if `staging` HEAD hasn't moved since the checkout's last sync (cheap
   git compare).
2. Otherwise fast-forwards the isolated checkout + rebuilds the SPA (reusing
   `setup-release-checkout.sh`, same machinery as a real release cutover).
3. **Then runs a plain `systemctl --user restart papercup-staging-api.service`**
   — a genuine SIGKILL-then-restart cycle, \~10-13s hard down, confirmed live
   via `journalctl --user -u papercup-staging-api.service`:

   ```
   Stopping papercup-staging-api.service ...
   papercup-staging-api.service: Main process exited, code=killed, status=9/KILL
   papercup-staging-api.service: Failed with result 'signal'.
   Stopped papercup-staging-api.service ...
   Started papercup-staging-api.service ...          # ~10-13s later
   ```

Given git-sync auto-commits the whole fleet's work to `staging` continuously
(step 1's no-op almost never fires on a busy fleet), this restart cycle fires
essentially **every 5-7 minutes, indefinitely**, for as long as the fleet is
active. Anyone probing `:3170` for more than a couple of minutes has real
odds of landing a request inside that window.

**This is a real gap against the repo's own restart policy.** CLAUDE.md /
`repo-conventions.mdx` (and `dev:restart`'s own tool guidance) are explicit:
*"Never a raw `systemctl --user restart papercup-staging-api.service`"* —
that's exactly what step 3 does, just from automation instead of a human. It
bypasses:

* **the drain** (`dev:restart`'s `guardResource` exclusive-hold — existing
  users are given a chance to finish before the restart lands),
* **the coalesce cooldown** (`staging-server-cooldown`, `STAGING_COOLDOWN_SEC`
  \= 120s in `dev/restart.ts`) — so an agent's `dev:restart` and the timer's own
  restart don't know about each other and can compound.

The timer's 5-minute cadence is an explicit, documented owner tradeoff
(freshness vs. thrash — see the `.timer` unit's own comment), not itself a
bug; the bug is that the *mechanism* it uses to apply that tradeoff is the
exact uncoordinated raw-restart anti-pattern WI-4221 already named and fixed
for humans/agents, just never closed for this one automated caller.

## Fix (EI-13221)

1. **`sync-staging-checkout.sh`** now skips its own restart when the unit's
   current MainPID already started less than `PAPERCUSP_STAGING_SYNC_RESTART_GRACE_SEC`
   (default 45s) ago — most likely a peer's `dev:restart` (or the previous
   tick) already cycled it, so restarting again would just double the outage
   for no freshness benefit. Fail-soft: any probe hiccup falls through to the
   normal restart (matches `probeServiceStart`'s own contract).
2. **`dev:service_health`** (`packages/operator-core/lib/agent-tools/dev/service_health.ts`)
   gained `overlaySystemdRestartRecency` — for every `systemd-user` supervised
   unit, it live-probes `secondsSinceStart` (the same OS ground-truth
   `dev:restart`'s coalesce check already trusts, `systemd-service-probe.ts`)
   and, when the unit started in the last `RECENT_RESTART_WINDOW_SEC` (20s),
   attaches a `recentRestartNote` explaining a concurrent connection-refused
   is very likely that restart, not an outage. This closes a real blind spot:
   `staging-api` isn't in the HTTP-probed `HEALTH_ENDPOINTS` rotation and its
   restarts (being timer-driven, not down-then-up transitions the reconciler's
   own flap counter observes) never tripped `flapState` either — before this
   fix, NOTHING in `dev:service_health` reflected this unit's actual restart
   cadence at all.
3. Documented the independent restart cadence + the diagnostic path in
   `repo-conventions.mdx`'s two-port section (previously silent on it — the
   section described only the deliberate human/agent restart path).

## The tell

If you hit a connection-refused against `:3170` and it clears on its own
within \~15s: call `dev:service_health` and look at the `staging-api`
supervision entry's `secondsSinceStart` / `recentRestartNote` before treating
it as a real outage, a memory-watchdog recycle, or evidence your own change
broke something.
