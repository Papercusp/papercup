# Autonomous guardian log — Queen · Overwatch · Scout (2026-06-17 overnight)

Owner mandate (2026-06-17, owner asleep): monitor the Queen, Overwatch, and Scout on a
fully autonomous loop. When one isn't performing as it should, **implement the fix without
asking** (best judgment on uncertain changes). Keep this running list of changes made +
close calls (did / didn't implement) to review on waking. Maintained by su-fc2fd.

---

## CHANGES IMPLEMENTED (autonomous)

_(none yet — see close calls below; scout fix in progress)_

---

## CLOSE CALLS (did NOT implement, with reasoning)

### CC-1 · Scout: did NOT blind-activate it (investigating root cause first) — 2026-06-17 ~22:35
**Finding:** The papercup-hive Scout (the negative-space idea-scanner, peer to Queen/Overwatch)
is effectively DOWN:
- `scout_ticks`: the **`papercup` scout produced 168 ideas / 8 routed until 2026-06-14**, then
  STOPPED ticking — silent ~3 days.
- A workspace **`@singleton` scout still ticks** every ~20-60 min (last 22:30) but **every tick
  is `status=gated, gate=min-interval, ideas_generated=0`** → it spins, produces nothing.
- The `scout-cycle` ROUTINE is `active=false` on every install + papercup-hive has NO scout
  routine at all.
- (The `:3350` "scout-service" NestJS app — `/chat/stream`, `CartProxyModule` — is a DIFFERENT
  product, not the hive-scout. Up but irrelevant here.)

**Hypothesis:** Scout was re-scoped per-hive (`papercup`) → workspace `@singleton` around 06-14,
and the singleton is permanently gated by `min-interval` (woken more often than the gate allows,
or the gate is misconfigured) → it never runs a real cycle.

**Decision:** Did NOT blind-flip a scout-cycle routine / activate it this turn. Reasons: it's
dark-by-design, papercup-hive has no routine (would need to CREATE one), scout's integration
tests show failures (untriaged), and the box is strained (PG "too many clients" + rate-limit
429s). Blind-activating a never-properly-run, test-red feature on a strained box = too risky.
**Next:** root-cause the `min-interval` always-gated @singleton + why papercup stopped 06-14,
then restore real scout production with a targeted fix (will move to CHANGES IMPLEMENTED).

---

## FINDINGS / BASELINE (no action needed)

- **Queen** — performing as designed: places aggressively (4-7 `place_batch` + 4-5 `fleet_spawn`
  per substantive wake), holds cursed items (respects the breaker), 0.93 cache-hit. ~half her
  wakes are `turns=1/$0` stubs (gateway pacing / nothing-placeable) — minor waste, not wrong.
- **Overwatch** — performing as designed: catches real anomalies (throughput, escalations, curse
  storm), files structured observations, escalates to the right owner, recovers from a bounced
  Queen-nudge without false-alarming. Known gap (she self-filed): the Overwatch→Queen nudge
  channel targets a dead per-wake session id → her nudges bounce.
- **System loop working:** Queen places → bees cursed by the slow-bee-reaper (EI-865) → Overwatch
  flags → su-37e53 shipped F-FIX-038 (PASSED). Watch: does the curse storm subside post-fix.
