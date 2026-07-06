# worker-log EI-7312

**Outcome:** fixed (resolved via improvements:resolve)

## What the EI was
"CHRONIC autoloop failure: loop-su-9ff27e79-8f34-40c9-b0db-3db3f8a727d4@* red 6 consecutive fires", last_status `loop-stuck-backstop`. Auto-filed 2026-07-04 05:41 by the `autoloop-chronic-failure` sweep.

## Diagnosis (phantom of an already-fixed class)
- Live state (dev:pg_query): the `harness_shared.autoloop_state` row for `loop-su-9ff27e79-…` is **fully GC'd (0 rows)**, its `harness_shared.routines` row is `active=false`, and there is **no `coord_presence` row** for the su owner. The live "chronically-red autoloop" condition no longer exists — the sweep cannot re-file it.
- This is the exact EI-7220/EI-7297/EI-7299 class: a DEAD `loop:arm` owner loop whose routines row was reaped, so the sweep's LEFT JOIN yields `routine_target_owner_id=NULL` and (pre-fix) the fragile owner-id marker fails open → it escalated as if a witness-less fixed system role.
- Root cause already fixed: `isLoopArmOwnerRole()` (the join-independent role-name guard — any `autoloop_state.role` starting with `loop-` is a `loop:arm` owner loop, which is owner-witnessed and auto-terminated by the reconcile dead-owner guard with its OWN escalation). Landed **2026-07-05 12:10 in commit `34ab1dc348`** — a day AFTER EI-7312 was captured (2026-07-04 05:41). Confirmed present on current staging HEAD.

## Change made
Test-only: added a distinct real-incident regression pin **EI-7312** to `packages/operator-core/lib/harness/routines/autoloop-chronic-failure.test.ts`, mirroring the byte-identical EI-7297/EI-7299 pins (orphaned `loop-su-*` row, streak exactly 6, `loop-stuck-backstop`, routine GC'd → both `routine_active` and `routine_target_owner_id` NULL, fired 1min ago). Asserts `selectChronicFailures(...) === []`. No source change needed — the fix is already deployed.

## Files changed
- `packages/operator-core/lib/harness/routines/autoloop-chronic-failure.test.ts` (+1 test case)

## Tests run
`TMPDIR=/tmp node node_modules/.bin/vitest run lib/harness/routines/autoloop-chronic-failure.test.ts` → **44 passed (44)**, 0 failed (was 43 before the pin).

The pin genuinely guards the fix: without `isLoopArmOwnerRole`, the orphaned row fails all three guards (owner-id null, routine_active null, not stale) and escalates, so `.toEqual([])` would fail — the same fails-before/passes-after property as its EI-7297/EI-7299 siblings.

## Infra blocker cleared (not code)
The affected test first failed with `ENOENT: mkdir '/tmp/claude/…/ssr'` — a fallout of the WI-3087 `/tmp` wipe incident (a non-recursive mkdir expects `/tmp/claude` to pre-exist). Recreated `/tmp/claude` and ran with `TMPDIR=/tmp`; test then ran clean. (WI-3087 all-clear was already announced by su-87598.)

## What the validator should re-verify
- The added test compiles + passes under `npm run test:affected` on the release box (I ran it via the root vitest binary with TMPDIR=/tmp due to the /tmp/claude infra quirk).
- No new insight doc written: this recurring class is already covered by `agent-insights/loop-wake-turn-deaths-recorded-as-delivered.mdx`, the module header runbook, and the mem0 "Phantom loop-su routine-failure EIs" fact — a new doc would duplicate.
