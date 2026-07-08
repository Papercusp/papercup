# \"Unresolved escalation in harness X\" phantoms: a stale/orphaned harness_escalations row, not a live problem
URL: /internal/docs/agent-insights/unresolved-escalation-phantom-orphaned-slug

The recurring auto-implement EI 'Unresolved escalation in harness X' is almost always a PHANTOM — a harness_shared.harness_escalations row whose escalation is set + supervisor_notes empty, while the underlying condition is long since resolved. The green-checkpoint-{stall,watchdog} variants self-clear via trackGateStall / green-stall-watchdog only when the row's harness_slug equals the LIVE install-slug; a row keyed under a DEAD/renamed slug (e.g. legacy 'papercup' after the papercup→papercusp rename, which has no live green-checkpoint routine) can never be matched by the clear. As of the EI-8396 fix, collectEscalationSignals now SUPPRESSES exactly those two green-checkpoint phases when the row's install-slug has no live green-checkpoint routine, so a dead-install orphan of those phases no longer loops forever. A stale row under any OTHER phase (or a same-slug row that just never got cleared) still re-fires the watchdog every tick. The drill: confirm the real condition is resolved via routines.gate_health, then clear the stale row (escalation=NULL + supervisor_notes) — do NOT try to 'fix' a green gate.

## The signal

The self-improvement loop dispatches an auto-implement worker on an EI titled
**"Unresolved escalation in harness `X`"** (watchdog source `unresolved-escalation`,
key `escalation:<harness>:<phase>`). It has recurred many times for the
`green-checkpoint-stall` phase: EI-7335 / 7447 / 7557 / 7569 / 7575 / 7690 (and the
`quartermaster*` siblings).

## What it actually means

`collectEscalationSignals` (watchdog.ts) fires for **every** row in
`harness_shared.harness_escalations` where `escalation <> '' AND supervisor_notes = ''`
— **except** the two green-checkpoint phases when the row's install-slug has no live
green-checkpoint routine (the EI-8396 dead-install guard, below). It is otherwise a
**presence** check on a durable row — it says nothing about whether the underlying
condition is still live. So a stale row that never got cleared re-fires the signal
**every tick**, re-dispatching a worker indefinitely on a problem that is already gone.

There are two green-checkpoint escalation phases, both keyed on the LIVE install-slug for
their clear (so both are covered by the dead-install guard):

* `green-checkpoint-stall` — written by `trackGateStall` (release-actions.ts,
  `GATE_STALL_PHASE`) when `main` is held red too long.
* `green-checkpoint-watchdog` — written by the standalone green-stall-watchdog.ts
  (`WATCHDOG_PHASE`, its own `watchdogAlerted` dedup flag).

The `green-checkpoint-stall` row is **cleared on the first green tick** by `trackGateStall`
(release-actions.ts) via:

```sql
UPDATE harness_shared.harness_escalations SET escalation = NULL, mtime_ms = $now
 WHERE harness_slug = ctx.installSlug AND phase = 'green-checkpoint-stall' AND escalation IS NOT NULL
```

The clear keys on `ctx.installSlug` — the **live** install running the green-checkpoint
routine. `green-checkpoint-watchdog` has a mirror clear in green-stall-watchdog.ts keyed the
same way.

## The orphaned-slug trap (EI-7690)

If the row's `harness_slug` is **not** the live install-slug, the clear can never match
it. This happens after an **install-slug rename**: legacy `papercup` (4 routines, **no**
`system:green-checkpoint`) vs the live `papercusp` (186 routines, has it). A
`green-checkpoint-stall` row keyed under `papercup` — whose escalation **body** correctly
says `harness_slug: papercusp` — is permanently orphaned: no routine runs as `papercup`, so
nothing ever clears it, and the watchdog re-fires forever.

`WI-2825` hardened the **same-slug** 0-row clear-miss (a loud `console.warn`,
`shouldWarnOnStallClearMiss`, when `gate_health.stallAlerted` is true but the clear matched
0 rows). It did not cover the different-slug/dead-install orphan — that gap was tracked as
**EI-8396**.

**EI-8396 is now fixed (current behavior, 2026-07):** `collectEscalationSignals` no longer
blindly re-fires a dead-install green-checkpoint orphan. Its query suppresses a row whose
`phase` is one of the two green-checkpoint phases when **no live green-checkpoint routine
exists for that row's install-slug**:

```sql
AND NOT (
  e.phase = ANY(ARRAY['green-checkpoint-stall','green-checkpoint-watchdog'])
  AND NOT EXISTS (
    SELECT 1 FROM harness_shared.routines r
     WHERE r.workspace_id = e.workspace_id
       AND r.install_slug  = e.harness_slug
       AND r.name = 'green-checkpoint'
       AND r.active
  )
)
```

So the `papercup`-orphan class (a green-checkpoint escalation under a dead/renamed slug with
no live `green-checkpoint` routine) is now **silently skipped** — it no longer re-dispatches a
worker forever. The guard is deliberately narrow: it only touches those two phases, and only
when the install-slug is genuinely dead; a same-slug row that just never got cleared, or a
stale row under any other phase, still re-fires and still needs the manual clear below.

## The drill (how to resolve one of these EIs)

1. **Don't try to "fix" the release gate.** Read the LIVE condition first:
   ```sql
   SELECT metadata->'gate_health', last_fired_at
     FROM harness_shared.routines
    WHERE install_slug = '<live-slug>' AND target_role = 'system:green-checkpoint';
   ```
   `consecutiveReds = 0`, `stallAlerted = false`, a recent `lastGreenAt` + `last_fired_at`
   ⇒ the stall is **resolved**; the escalation is a phantom.
2. **Check for a slug mismatch.** Compare the row's `harness_slug` column against the live
   install-slug and the escalation body's `harness_slug`. A dead/renamed slug (no matching
   `system:green-checkpoint` routine) is the orphan case.
3. **Clear the stale row** (the sanctioned remediation — same as every sibling EI): set
   `escalation = NULL` **and** write `supervisor_notes` documenting why. Either clause
   alone stops `collectEscalationSignals` from re-firing.
4. **Resolve the EI `fixed`** with the gate\_health evidence. This is a **state-only**
   cleanup — zero code lines change — so the contract's "evidence says it no longer
   exists = verified fix" path applies; there is no unit diff to test.
5. **For the two green-checkpoint phases, the durable fix already landed** (EI-8396):
   `collectEscalationSignals` now suppresses a dead-install orphan of those phases, so it
   should no longer recur from a renamed slug. If you still see a green-checkpoint phantom,
   the row's install-slug probably DOES have a live `green-checkpoint` routine (a same-slug
   clear-miss, not the dead-install case) — check for the `shouldWarnOnStallClearMiss`
   warning and clear the row manually. For any OTHER phase, a stale presence row still loops;
   the manual clear (step 3) is the remediation, and a per-phase durable clear on a protected
   surface is the real fix to file.
