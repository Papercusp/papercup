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

### CC-1 FINAL (2026-06-17 ~23:20) — diagnosis SETTLED; recommend a decision before a fix
- Scout's cycle MACHINERY WORKS — the scout-live integration test passed (EXIT:0) under a
  real model. So scout is NOT broken and NOT a missing budget (defaults apply).
- The real problem is **cadence-starvation**: scout fires only on `idle-capacity`
  (`idleRatio ≥ 0.5`, cadence.ts) OR the ~24h `heartbeat`. The papercup hive is busy (Queen
  placing), so idleRatio stays low → scout almost never fires → effectively dark. When it last
  fired (19:30, mid-throttle) the LLM was paused → `no-ideas`.
- LLM is now HEALTHY (opus 3/45 rpm, $23/hr spent) — so a fire NOW would likely produce.
- Topology is multi-component (scout-service:3350 + bp-singleton-* blueprint routines +
  scout-cycle routines + the scout_ticks scheduler) and the EXACT per-scout cadence-config
  lever for @singleton is non-obvious.

**Two fix options, both with a real tradeoff → flagging rather than blind-applying:**
  (A) Lower scout's heartbeat ceiling / idle threshold so it fires regularly. The clean lever is
      the cadence DEFAULT (cadence.ts maxIntervalSec 86400→~3600) BUT that's GLOBAL — it makes
      scout fire hourly across ALL ~135 installs (xbench etc.) = a large fleet-wide LLM-spend
      increase on an already strained box (PG 'too many clients', recent rate pauses). Too blunt.
  (B) Per-hive scout cadence override (just papercup-hive) — the targeted, correct fix, but the
      per-hive scout cadence-config mechanism isn't confirmed + papercup-hive has no scout-cycle
      routine of its own (would need creating one).

**DID NOT implement either:** (A) is too expensive/blunt on a strained box; (B) needs confirming
the intended scout scope (workspace `@singleton` vs per-hive `papercup-hive`) — a design call.
**RECOMMENDATION for owner:** confirm (1) should scout be per-hive (papercup) or workspace
singleton, and (2) OK to raise fleet-wide scout firing (cost). Then the fix is ~1 cadence change.
Meanwhile: watching for scout's next natural fire under the healthy LLM (would confirm it
produces); Queen/Overwatch healthy.

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
