# worker-log — EI-6691 (implement / self-improvement auto-fix)

## Item
EI-6691 (bug): "CHRONIC autoloop failure: loop-su-7ad9961c-a863-4bc3-84e8-092c0eec65f0@* red 222 consecutive fires". last_status verbatim: `loop-stuck-backstop`.

## Diagnosis — stale pre-fix ticket (same class as EI-6702 / EI-6693 / EI-6730 / EI-6694 / EI-6692)
Reproduced live via PG. The `autoloop_state` row (role `loop-su-7ad9961c-…`, ws
`papercusp-workspace`, harness `*`):
- `consecutive_errors=222`, `last_status='loop-stuck-backstop'`
- `last_fired_at=2026-07-01 06:09:42` — ~3.5 days stale (today 2026-07-04)
- matching `harness_shared.routines` row: **`active=false`**, `next_fire_at=infinity`,
  `target_owner_id=su-7ad9961c-…` (non-null → a `loop:arm` OWNER loop), `reschedule_interval_sec=120`
- `coord_presence` rows for owner `su-7ad9961c-…` = **0** → the owner su-session DIED → every
  loop fire black-holed (`loop-stuck-backstop`), streak climbed to 222. The routine engine already
  resolved the LIVE condition (`active=false` / `infinity` → the loop no longer fires).

The `autoloop_state` row was a FROZEN red watermark. ALL THREE shipped chronic-failure guards in
`selectChronicFailures` independently suppress this exact shape (→ `[]`):
1. `isLoopArmOwnerLoop` (`target_owner_id` non-null — owner-witnessed, has its own dead-owner
   escalation `escalateDeadLoop`) — EI-6727.
2. `routine_active === false` (auto-paused — resolved, not live) — EI-6760/6761/6762.
3. `isStaleWatermark` (last fire > 6h → frozen watermark, streak can never reset) — EI-6765.

EI-6691 was filed 2026-07-02 (createdAt), before these guards landed → a stale pre-fix ticket.
The generator will NOT re-escalate this row.

## Why NO new code / regression pin (avoiding dead weight)
`selectChronicFailures` already returns `[]` for EI-6691's exact shape.
`autoloop-chronic-failure.test.ts` already pins the IDENTICAL all-three-axes shape
(loop:arm-owner + `active:false` + >6h-stale + `loop-stuck-backstop`) at streaks **220 (EI-6694)**
and **221 (EI-6692)** — both BRACKETING 222. A 222-streak pin is strictly-dominated dead weight
(the repo discourages near-duplicate pins — same call the EI-6702 worker made for its 97-streak),
so none was added. The existing suite is the regression evidence.

## Remediation (matches EI-6702 / EI-6730 precedent)
`autoloop:control reset-errors { harness:'papercusp', role:'loop-su-7ad9961c-…' }` → cleared the
`*`-scope frozen watermark (rowsReset:1). Verified: `consecutive_errors=0`, `last_status='errors-reset'`.

## Tests
`cd packages/operator-core && npx vitest run lib/harness/routines/autoloop-chronic-failure.test.ts`
→ 32 passed. Proves the code suppresses EI-6691's exact shape (via the identical-shape EI-6694@220
+ EI-6692@221 pins).

## Validator re-verify
- Confirm `autoloop_state` row for `loop-su-7ad9961c-…` stays at 0 errors / `errors-reset` and does
  NOT re-escalate (routine is `active=false`/`infinity`, so it will never fire again).
- Class generator residue (escalation-timing) remains tracked under the pre-existing OPEN item
  EI-7016 (per EI-6730) — not re-filed here.
