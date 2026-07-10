# Brief D — Concurrency, conflict resolution & convergence — findings

Owner: su-75f52. Lane: concurrency / conflict / convergence (S0 lane).
Method: integration + property-based; no live instances (no dependency on the
broken `.deb` blocking lanes A/E/G).

**Dimension verdict: RED.** One reproducible **S0 non-convergence** (D-001) on
current `staging`: under realistic clock skew, two honest peers materialise
DIFFERENT rows for the same key and never reconcile. Everything else in scope
(claim exactly-once, authority churn, crashed-holder steal, monotone-clock
convergence across all content types) is correct and covered.

---

## D-001 — Federated LWW silently diverges: the merge fold orders by HLC, the PG projection guard orders by `fed_ts` (S0)

**Severity: S0** (non-convergence / silent data divergence — the rubric's
"non-convergence" blocker). Reachability is conditional on clock skew of a
particular shape (below), but the failure is permanent once triggered and the
divergent layer is the one every consumer reads.

### Claim

A federated write passes through **two** independent ordering decisions that
must agree but do not:

1. **The merge winners-fold** — `read-merge.ts` `mergeAdmittedLogsIncremental` →
   `beatsStored` ≡ `lwwPick` (`projection.ts:319`). Since P-010 this orders by
   the op's **HLC** when both ops carry one.
2. **The PG projection LWW guard** — every mutable projection's
   `INSERT … ON CONFLICT … WHERE stored.fed_ts IS NULL OR EXCLUDED.fed_ts >=
   stored.fed_ts` (e.g. `harness-features.ts:212`). This orders by **`fed_ts`**,
   and `fed_ts = provenance.ts = op.ts` (`projection.ts:249,255` →
   `harness-features.ts:140`; identical in all 18 projections — `grep "const
   fedTs = provenance"`). `fed_ts` is wall-clock, NEVER HLC-derived (migration
   214 stamps a local write with `clock_timestamp()` and respects a
   projection-supplied `op.ts` verbatim).

The merge only **hands the HLC-winner to apply** (an HLC-loser is suppressed by
`beatsStored`). When the HLC-winner has a *lower* `fed_ts` than an HLC-loser on
the same key, the PG guard **rejects the HLC-winner**. So the materialised row
depends on the per-peer fold order, and the two authors of a contested key end
with different rows — both quiescent (`fixedPoint=true`).

### This was found and "fixed" on 2026-06-14 — the fix is INCOMPLETE

`agent-insights/hlc-merge-vs-fed-ts-guard-divergence.mdx` documents this exact
divergence and a fix: seed the HLC physical from the op's own `ts`
(`stampOpHlc`: `encodeHlc(clock.now(op.ts))`). That closed the **drain-interleave**
trigger (HLC stamped by wall-clock-at-drain). It does NOT close the root cause:

- Seeding from `op.ts` only guarantees `HLC.physical ≥ op.ts` for the **same** op.
- `HlcClock.send(ts)` returns `max(clock.physical, ts)`. The **RECV seam**
  (`observeRemoteHlc`, `projection.ts:208`) — which the fix DELIBERATELY
  preserves "to keep causality" — advances `clock.physical` ABOVE a later write's
  `ts`. So HLC order and `fed_ts` order DECOUPLE again, now triggered by
  recv-advance instead of drain-interleave.

The doc's claim "Now the merge's HLC order matches the PG guard's `fed_ts` order
→ no silent rejection" is false for any peer that observed a higher-HLC remote op
before writing. (I corrected the insight doc — added a `## REOPENED (D-001)`
section.)

### Why the green suite missed it

- `split-brain-mug.integration.test.ts` and `composition-rig.ts` share ONE wall
  clock (`physical: () => this.now()`), so they cannot construct recv-advance +
  skew — they only ever exercised the drain-interleave case the fix closed.
- `three-peer-partition-rejoin.test.ts` (the best partition/convergence test)
  asserts convergence at the **read-merge layer with a test-local ts-only LWW**
  (`finalState()` folds `op.ts >= cur.ts`) and an **injected apply sink** — its
  ops carry **no HLC** and never touch the PG guard. It exercises neither of the
  two layers whose disagreement IS D-001, so it could never catch it.

### Evidence — concrete trace (`status` markers W/L on one feature key)

- **W** (HLC-winner): author observed a remote op at HLC.physical 9000 (recv
  advance), then wrote KEY at wall `ts=1000` → HLC `(9000,·)`, **fed_ts 1000**.
- **L** (HLC-loser): fresh-clock peer wrote KEY at `ts=5000` → HLC `(5000,0)`,
  **fed_ts 5000**.

```
W's author folds own write first  [logW, logL]:
  apply(W) → PG = W (fed_ts 1000);  L arrives → beatsStored(L,W)=false → suppressed → PG = W
L's author folds own write first  [logL, logW]:
  apply(L) → PG = L (fed_ts 5000);  W arrives → handed to apply →
    WHERE EXCLUDED.fed_ts(1000) >= stored.fed_ts(5000) is FALSE → rejected → PG = L
⇒ W's peer keeps W, L's peer keeps L. Permanent split-brain.
```

`lwwPick`/`beatsStored` agree the winner is W on both peers (the in-memory fold
converges); only the materialised PG rows diverge — and PG is what the feature
queue, status badges, claim flow, and PR daemon read.

### Reachability

`HLC.physical` is monotone (`send`/`recv` only take `max`) and propagates the
**global-max wall-ts** ever seen anywhere (recv takes `max(local, remote, now)`).
So a single forward clock excursion on ANY peer at ANY past time (NTP overshoot,
a fast VM, a manually-set clock) raises the HLC floor for the whole pot
**permanently**. Thereafter any two concurrent same-key writes whose wall-`ts`
order differs across peers can diverge. The window self-heals only once every
peer's wall clock advances past the floor. So: not every concurrent edit
diverges, but the trigger is ordinary multi-second skew + one historical
forward jump — squarely in scope for a public release on heterogeneous machines.

### Repro (all on current `staging`, teeth-verified)

- `packages/operator-core/lib/sync/hyperbee/__tests__/lww-hlc-fedts-divergence.test.ts`
  — fast (no Docker): the REAL merge (`mergeAdmittedLogsIncremental` +
  `beatsStored`/`lwwPick`) + REAL `stampOpHlc`/`HlcClock` seams + a line-for-line
  transcription of the PG `fed_ts` guard. The convergence assertion is `it.fails`
  (currently RED = the S0); a characterisation test shows peerA=L / peerB=W; a
  control proves the no-inversion case converges (so the harness has teeth).
- `…/lww-hlc-fedts-divergence.integration.test.ts` — the AIRTIGHT twin: same
  scenario driven into the REAL `buildHarnessProjectionApply` against a REAL
  migrated Postgres (genuine UPSERT guard + migration-214 trigger). Same result.
- `…/convergence-fuzz.test.ts` + `_convergence-fuzz-rig.ts` — the seeded
  property-based sweep (below): monotone regime converges on every seed; skew
  regime finds the divergence.

### Fix options (design call + migration — NOT a low-risk in-lane patch)

The clean fix is **one ordering key of record, end to end**:

- (a) Carry the merge's ordering key to PG — add an `hlc` column to each
  consolidated table and make the guard `WHERE EXCLUDED.hlc >= stored.hlc` (fall
  back to `fed_ts` when null). Direct, but a migration across the 18 projections
  + capture triggers.
- (b) Derive `fed_ts` from the HLC physical (`packHlc`) so the existing guard
  orders by the same causal clock the merge does. Smaller surface, but `fed_ts`
  is also used by the delete ts-guard, the migration-214 local-stamp, and capture
  masking — all must move together.
- (c) Make the merge fold by `fed_ts` too — abandons the causal correctness HLC
  was added for; not recommended.

**Recommendation:** treat as a release blocker; pick (a) or (b) with a deliberate
design decision. Filed to the owner via coord (cross-cutting — out of this lane's
low-risk fix mandate, per the README rule). I did NOT self-patch.

**Fix implementation constraint (code-derived — shapes the a/b choice):** the fix
is NOT just "add an `hlc` column + change the guard". HLC is assigned at ONE site
— the drain/append seam (`boot.ts:1465 stampOpHlc`, the only call) — so it lives
on the outbound LOG OP, never in the local PG row. A LOCAL write's row is stamped
by migration-214 with `fed_ts = clock_timestamp()` and carries NO hlc (no hlc
column exists on any consolidated table). Consequence: under approach (a), a
stored LOCAL row would have a NULL hlc, so an incoming remote op falls back to
`fed_ts` against it → the local-vs-remote divergence persists. So BOTH approaches
must move/duplicate HLC assignment to the LOCAL-WRITE moment (the local write path
or the mig-214 trigger must consult the HLC clock), not only at drain. That
write-time-vs-drain-time rework is the real design depth — and exactly why this is
an owner decision, not a mechanical patch. (The fuzz validation below feeds the
guard ops that already carry an hlc, so it proves the comparator direction; it
does not exercise the local-row-has-no-hlc gap — that's a fix-design note, not a
gap in the repro.)

**Fix direction VALIDATED empirically (no production change):** the fuzz harness
has a swappable guard `guardOrder: 'fed_ts' | 'lww'`. With `'lww'` (the guard
orders by the merge's own `lwwPick` comparator — put AND del — i.e. "one ordering
key of record"), the SAME skew sweep that diverges under `'fed_ts'` **converges on
all 120 seeds**. Paired A/B test: diverges-under-fed_ts > 0, diverges-under-lww =
0 (`convergence-fuzz.test.ts` → "D-001 fix VALIDATION"). So both fix options (a)
carry-hlc-to-the-guard and (b) derive-fed_ts-from-HLC are confirmed to resolve
the divergence — the remedy is proven on the very harness that exposes the bug,
which de-risks the migration decision.

---

## Convergence matrix (content type × scenario)

Legend: ✅ proven convergent (new or existing test) · 🟥 S0 divergence (D-001) ·
n/a not applicable to that mechanism.

| Content type | Mechanism | Concurrent same-key (no skew) | Concurrent same-key (clock skew) | Partition / heal | Authority churn | Crashed-holder steal |
|---|---|---|---|---|---|---|
| features (`features-by-id`) | LWW | ✅ fuzz | 🟥 **D-001** | ✅ fuzz (N-peer) | n/a | n/a |
| work-items / issues | LWW | ✅ fuzz | 🟥 **D-001** | ✅ fuzz | n/a | n/a |
| plans (`harness_plans`) | LWW | ✅ fuzz | 🟥 **D-001** | ✅ fuzz | n/a | n/a |
| plan-item assignments | LWW | ✅ fuzz | 🟥 **D-001** | ✅ fuzz | n/a | n/a |
| coord messages / posts | LWW | ✅ fuzz | 🟥 **D-001** | ✅ fuzz | n/a | n/a |
| presence / pot-settings / pot-members / contributors / feature-queue | LWW (same guard) | ✅ (same comparator) | 🟥 **D-001 (by construction — identical guard)** | ✅ | n/a | n/a |
| feature_claims / plan_item_claims | append-only + authority | ✅ exactly-once | ✅ (no HLC, unaffected) | ✅ | ✅ | ✅ |
| work-item leases (authority) | authority-serialized | ✅ exactly-once | ✅ (no HLC, unaffected) | ✅ fail-open reconcile | ✅ re-election | ✅ steal + late-write superseded |

### Projection guard audit (real code — all 19 projection files)

Verified directly (not assumed from the fuzz harness's uniform model): every
mutable projection carries the **identical** put guard (`WHERE … EXCLUDED.fed_ts
>= stored.fed_ts`) + del ts-guard — `harness-features`, `harness-plans`,
`engineer-issues`, `issues`, `plan-item-assignments`, `coord-message`,
`coord-thread(-post)`, `coord-conversation`, `presence`, `pot-members`,
`pot-settings`, `contributors`, `feature-queue`, `feature-working-set`. So
D-001 is **universal across every mutable LWW table by construction**, not a
per-table accident. The non-LWW families are correctly different:
`feature-claims` + `usage` are **append-only** (`ON CONFLICT DO NOTHING`, del =
no-op) → no LWW, no guard, unaffected by D-001; `harness-plan-parts` recomposes
`harness_plans.content` from the LWW-merged parts and (correctly) has no own
guard — but **inherits D-001 at the part granularity** (flag-gated, DARK by
default). `register-all` is the builder, not a writer.

The LWW rows share ONE comparator pair (HLC in the fold, `fed_ts` in the guard),
so D-001 is **universal across every LWW content type** — not feature-specific.
The claim/authority rows use a DIFFERENT mechanism (append-only `ON CONFLICT DO
NOTHING` + per-Pot authority serialization) and carry **no HLC** (claims use raw
`ownLog.append`, never LWW — `hlc-stamp.ts:14`), so D-001 does not touch them.

### LWW rule, documented per type

- **All mutable LWW tables** (features, issues, plans, plan-item-assignments,
  coord messages/posts/conversations/threads, presence, pot-settings,
  pot-members, contributors, feature-queue, feature-working-set, plan-parts):
  in-memory winner = higher **HLC**, then `del` beats `put`, then
  lexicographically-greater `sourceLogKeyHex` (`lwwPick`, total + fold-order
  independent). Materialised winner = higher **`fed_ts` (= op.ts wall clock)**,
  ties → `>=` lets the incoming op overwrite. **These two keys disagree under
  clock skew → D-001.**
- **Append-only claims** (`feature_claims`): `ON CONFLICT DO NOTHING` — first
  writer per distinct (item, claimer, attempt) wins; no LWW; deterministic.
- **Authority leases:** the per-Pot authority (argmin device pubkey among
  presence rows fresher than the 90s stale window) serializes claims; exactly one
  grant per epoch; a lapsed lease (no heartbeat for its TTL) is stealable with a
  fresh `claim_id`; a zombie's late completion is **superseded, never adopted**
  (`lease-steal-semantics.ts` D-007).

---

## Gaps closed (new tests, teeth-verified)

1. **Seeded property-based convergence harness** (`_convergence-fuzz-rig.ts` +
   `convergence-fuzz.test.ts`) — the brief's named deliverable. Deterministic
   mulberry32 PRNG (no `Math.random`); generates a random universe of writes
   across **5 content types**, delivers every op to **N peers** in arbitrary
   seeded fold orders with dups (modelling partition/reorder/re-delivery), drives
   the REAL merge into a faithful PG-`fed_ts`-guard store, and asserts
   byte-identical materialised state across all peers.
   - Monotone regime (no skew): converges on **120 seeds × 4 peers** and **40
     seeds × 8 peers / 120 ops / 10 keys** — the reusable regression guard.
   - Skew regime: the fuzzer FINDS D-001 (≥1 divergent seed; asserted).
   - Teeth: the harness diverges on the skew regime and converges on the
     monotone regime over the same generator → it distinguishes the two.
2. **D-001 focused repro** (fast + real-PG twin) — see above.

## Gaps NOT re-tested (already covered — verified, not assumed)

- **Concurrent claim exactly-once (scenario 2):**
  `work-item-claims-concurrency.integration.test.ts` — "8 concurrent acquires ⇒
  exactly ONE winner, 7 conflicts"; "N>M claimers via claim_next (SKIP LOCKED) ⇒
  each item ≤ once, exactly M distinct claims"; `two-instance-authority` — "two
  peers contend → authority grants exactly one".
- **Authority churn (scenario 4):** `authority-failover-flood.integration.test.ts`
  (flood across crash, zero contender grants, contender wins under epoch 2);
  `two-instance-authority` (authority ages out → next-lowest peer becomes
  authority — deterministic re-election); `cross-peer-coordination-scale`
  (FIVE-swarm cascading failover).
- **Crashed-holder steal (scenario 5):** `lease-steal-semantics.ts` +
  `work-item-claims-concurrency` G16/G17 — lapsed lease stolen + `claim_id`
  rotates; live (heartbeated) lease cannot be stolen; renewing owner holds then
  loses after heartbeats stop; zombie's late completion superseded (= the
  original's late write rejected).

## Gaps left open (with why)

- **Partition/heal at the REAL PG + real DHT for 4–5 peers across ALL content
  types.** The fuzz harness covers N-peer arbitrary-delivery convergence at the
  merge+guard layer (faithful guard, no Docker); the real-DHT multi-peer rig
  (`composition-rig`) is 2-cell and the existing `three-peer-partition-rejoin` is
  read-merge-only. Extending a real-DHT rig to 4–5 cells × all content types is a
  larger build than this lane's time allowed and is **moot until D-001 is fixed**
  (it would diverge for the same reason under skew). Recommended as the
  regression test FOR the D-001 fix.
- **HLC counter-overflow / 16-bit rollover under same-ms storms.** `bumpCount`
  rolls `ms+1` at `HLC_MAX_COUNT`; not fuzzed here. Low risk (the rollover keeps
  HLC monotone), noted for completeness.

---

## Release-readiness verdict for this dimension: **RED**

The substrate is a correct eventually-consistent store **only when clocks do not
skew in the D-001 shape**. The convergence guarantee the brief requires ("under
ANY ordering of concurrent writes, partitions, and reconnections, all honest
peers converge to the same state") does NOT hold: a single historical forward
clock excursion plus ordinary concurrent edits produces a permanent,
consumer-visible split-brain across every LWW content type. Claim/authority
convergence (exactly-once, churn, steal) is GREEN.

**Blocker:** D-001 — unify the merge fold and the PG LWW guard on one ordering
key of record. Until then, RED.
