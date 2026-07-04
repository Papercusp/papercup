# worker-log — EI-6721 (auto-implement)

## Bug
"CHRONIC autoloop failure: loop-su-24eedd86-43d9-4d6a-92f2-107509560b06@* red 42 consecutive fires"
(kind=bug). last_status at capture: `loop-stuck-backstop`; now `loop-terminal-unreachable`,
consecutive_errors=54, last_fired 2026-07-03 07:39 (routine `active=false`, paused).

## Root cause (diagnosed from live PG)
`loop-su-24eedd86...` is an ephemeral `loop:arm` OWNER loop: routine `target_role=system:loop-wake`,
`target_owner_id=su-24eedd86...`, and it was correctly auto-paused (`active=false`,
`loop-terminal-unreachable`) by the reconcile dead-owner guard when its su session died.

Two watchdogs read `autoloop_state`:
1. `autoloop-chronic-failure` sweep — ALREADY excludes auto-paused (`active=false`) rows AND
   loop:arm owner loops (`target_owner_id` non-null) via EI-6727. So EI-6721's own source won't re-file.
2. `collectCircuitOpenSignals` (improvements/watchdog.ts, source `fire-circuit-open`, title
   "Role fire-path for X/Y is stuck in error-backoff") — did NOT check routine state. It kept
   re-filing for this dead, paused loop:arm row (EI-6864/6912/6994/7127/7257/7386 — all re-created
   for THIS one loop as each prior EI got resolved). That EI-6727-class fix was never applied here.

## Fix (self/inline-sized)
`packages/operator-core/lib/harness/improvements/watchdog.ts`:
- `collectCircuitOpenSignals` now LEFT JOINs `harness_shared.routines` and drops rows whose routine
  is auto-paused (`active = false`) or is a loop:arm owner loop (`target_owner_id` non-null) —
  mirroring `selectChronicFailures`.
- Added pure `isResolvedFirePath(...)` helper + `.filter(...)` in `circuitOpenSignalsFromRows` so the
  suppression holds at the pure layer too (unit-testable, fail-open on unknown routine state).

Regression tests added in `watchdog.test.ts`: paused row → no signal; loop:arm owner → no signal;
fixed system role (no routine / no owner) → still fires; `isResolvedFirePath` truth table.

## The dead row itself
- Already OUT of the 24h `fire-circuit-open` recency window (last fired >25h ago) → deployed code
  won't re-fire it either.
- The class-2 `pruneStaleFireState` (EI-7009 — paused routine + `loop-terminal-unreachable` marker)
  is the designed cleanup for exactly this "permanently-red watermark" row. It is present in STAGING
  but NOT yet on `origin/main` (grep: 3 hits staging / 0 hits main) — that's why the deployed operator
  hasn't pruned it yet; it will self-clean once staging deploys.
- `autoloop:control reset-errors` (suggested by the bug body) is (a) blocked from this scoped session
  because harness `*` reads as the global-escape, and (b) counterproductive — it would rewrite
  last_status to `errors-reset`, DISABLING the class-2 auto-prune that's about to deploy. Left the row
  for the class-2 prune instead.

## Verified
`cd packages/operator-core && npx vitest run lib/harness/improvements/watchdog.test.ts \
  lib/harness/routines/autoloop-chronic-failure.test.ts lib/harness/routines/loop-unreachable-guard.test.ts`
→ 194 passed (watchdog.test.ts: 141, incl. 4 new). `tsc --noEmit` clean for the edited file.

Lands via the release gate.
