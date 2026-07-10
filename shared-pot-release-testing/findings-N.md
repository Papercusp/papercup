# Findings N — N-peer (3+) scale, churn & backfill-at-size

**Lane:** Brief N (S1). **Author:** su-c318e. **Date:** 2026-06-19.
**Method:** two layers — (a) merge-engine (`*.test.ts`, real Corestores + real
piped replication + the real incremental LWW merge, an idempotent `fed_ts`-guard
model as the apply sink) and (b) real-wire integration (`*.integration.test.ts`,
real Hyperswarm over a loopback testnet DHT + real PG projections via
`federatePeerSet`) — plus a live 2-peer scale-at-size note (su-9140a, attributed).
All new assertions **teeth-verified** (write green → neuter the invariant →
confirm RED → restore → confirm GREEN). Live 3+-peer is structurally impossible
on this box (2 gh identities; a 3rd reusing the owner identity corrupts admission,
findings A-NOTE), so 3+ peers are driven in the rigs per the brief's live
constraint.

## Verdict: **GREEN** (N-peer scale + churn + size) — 1 scoped caveat

Federation past the happy 2-peer pair is sound on both layers tested. At the
**merge-engine layer**: 3–5 peers converge on every content type (backfill for
late joiners + incremental both ways), join/leave churn under load re-converges
with no loss/dup, a large backfill lands in FULL across the multi-pass deferral
(no truncated tail), and watermarks are monotonic on two independent axes through
all of it. At the **real-wire layer** (real Hyperswarm + real PG projection): a
content type fans out to ALL of 3 peers, `origin='remote'` everywhere (it
genuinely crossed) — closing the gap the presence-only 5-peer scale test left
open. The one remaining caveat is a **scope boundary, not a failure**: the
joiner-resolves-own-topic discovery path is out of scope (Brief L) — every rig
here wires matching topics directly. No new S0/S1 in this lane.

The S0/S1 release blockers that touch scale are **owned elsewhere and not
re-litigated here**: D-001 (LWW divergence under clock skew — Brief J) and A-003
(hive_members/hive_settings don't federate to a joiner — Brief I). Brief N proves
the *scale/churn/size* properties of the merge engine **given** the LWW order is
correct; if D-001 ships unfixed, divergence is a content-correctness bug, not a
scale bug, and these tests (distinct-key + ts-ordered conflicts) stay green
because they don't inject clock skew. Noted so the verdict isn't read as "scale
clears the release" — it clears the **scale dimension**.

> **Cross-lane status update (~2026-06-19 14:11, from coord):**
> - **D-001 (Brief J / su-46b7a): GREEN, live-witnessed.** The dedicated `fed_hlc`
>   ordering-key fix (migration 314) landed; full sync/hyperbee federation
>   integration suite (48 files) green, unit 878 pass; AND a live split-brain skew
>   inversion on the shipped binary converged to the HLC-winner on both peers. S0
>   closed.
> - **A-002 (Brief H/dc9db): leg done** (2-pot collision path, no stall).
> - **A-003 (Brief I/su-d2230): RED** (corrected — my earlier note said "fix
>   landed"; d2230 then finalized it RED). The receive-side rebind is correct +
>   teeth-verified but **moot**: the dominant blocker is SEND-side — a pot-HOME
>   (`kind:'pot'`) harness never joins the topic / drains its own
>   `hive_members`/`hive_settings` outbox, so that content never federates off the
>   owner. Overlaps A-002 / the Move-1 pot-home-federation work.
> - **C-001 (owner decision): RE-KEY.** The owner ruled shared-pot MUST cut READ
>   access on member-remove / go-private (epoch group key + content encryption —
>   "Move 2") — now the **critical-path-to-public-release** build, subsuming A-003's
>   revocation enforcement + E-001. (Not scale-related; out of Brief N's lane.)
>
> My two test files were **re-run after Brief J's `fed_hlc` migration 314 landed —
> still GREEN** (the rig's hand-rolled DDL is independent of the migration chain).
> **Bearing on Brief N:** A-003's send-side gap is about the TWO tables explicitly
> excluded from this lane's content matrix (`hive_members`/`hive_settings`), so it
> does not change the scale verdict — the 8 content types that DO federate scale
> cleanly. Brief N proves scale *given* a content type federates; it does not prove
> WHICH types federate (that's A-003/Move-1's domain). git-sync remained throttled
> (EI-1607, kopia-safe) through this window — deliverables on disk + kopia, unpushed.

---

## N-peer matrix (merge engine) — `n-peer-scale-churn.test.ts`

New file:
`packages/operator-core/lib/sync/hyperbee/__tests__/n-peer-scale-churn.test.ts`
(`*.test.ts`, unit config — real Corestore + real replication streams, PG-free;
the projection→real-PG hop is covered per-table by
`fed-ts-lww-guard.integration.test.ts`). 5 tests, all green, all teeth-verified.

| # | Scenario | Peers × types | Status | What it proves |
|---|----------|---------------|--------|----------------|
| 1 | **Full-mesh fan-out** | 5 peers × 8 content types | 🟢 GREEN | Every author's row in every content type converges on **every** peer == a brute-force LWW oracle; cross-author crossing (each peer holds content from every other). |
| 2 | **Late-joiner backfill-at-size** | 3 seeders × 8 types × 18 = **432 rows**, then a cold 4th joins | 🟢 GREEN | The 4th joins dark, backfills the **FULL** set cold (set-semantics — which ids land, not a re-fold count); seeders unperturbed by the join. |
| 3 | **Backfill-at-size, tight budget** | 300 rows, `maxOpsPerPass=40` | 🟢 GREEN | The deferral path (EI-91): a backfill larger than one pass window lands in **full across passes** (≥2 passes, `caughtUp` only at the end) — never truncated to the first window. |
| 4 | **Join/leave churn under load** | 4 peers, 3 churn rounds, writes flowing | 🟢 GREEN | Each round a peer leaves (cables severed + dropped from the admitted set → **cursor reset everywhere**, the production caller-contract), everyone keeps writing (incl. the away peer on its own log), the peer rejoins (reset + re-backfill both ways) → all converge == oracle. No loss/dup. |
| 5 | **Conflict-through-churn** | 3 peers, shared key straddling a partition | 🟢 GREEN | A cross-author conflict written on both sides of a partition resolves LWW to the later write identically on every peer after heal. |

### Churn details (test 4)

- **Production-faithful churn, not partition.** `three-peer-partition-rejoin.test.ts`
  severs links but keeps a STABLE admitted set, so its `MergeCursor` is never
  reset. The production churn path (boot.ts caller-contract, `read-merge.ts`
  "CALLER CONTRACT") **resets the cursor on every admitted-set change** and
  re-folds from scratch — a path whose no-double-apply correctness rests entirely
  on the projection PG layer's `fed_ts` LWW guard (an idempotent forward-only
  keyed upsert), since the in-memory winners fold is empty right after a reset.
  This file drives that reset path directly (a keyed `PgModel` sink modeling the
  guard's `WHERE EXCLUDED.fed_ts >= stored.fed_ts` shape).
- **No double-apply** is structural: a keyed upsert = one row per key, so a reset
  replay that re-hands an already-winning op upserts the SAME row (idempotent).
- **No clobber** is the load-bearing guard: a reset replay re-hands now-stale ops
  (a prior round's losing conflict write held permanently on the author's own
  log) over a PG row already holding the winner → the guard **rejects** them
  (asserted: `rejectedByGuard > 0` in aggregate). When the guard is removed
  (neuter #1), a stale op is accepted and the run goes red — proving the guard is
  load-bearing, not decorative.
- **Asserted resets happened** (`resets > 0` per peer) so the test can't silently
  degrade to a no-churn stable fold and still pass.

### Watermark monotonicity (two independent axes)

1. **Cursor-position monotonicity** *within* a stable epoch — per-log
   `MergeCursor.positions` never moves backward between resets (the
   `three-peer-partition-rejoin` invariant, generalized to N peers). The cursor
   legitimately RESETS to 0 on an admitted-set change (by contract) — that is not
   a regression, and conflating the two is the trap; this axis is asserted only
   *within* an epoch.
2. **Materialized-row `fed_ts` monotonicity** *across everything incl. churn* — a
   peer's PG row for a key never moves backward in `fed_ts`, enforced by the guard
   and asserted on every accepted apply (`PgModel` high-water mark). This is the
   churn-robust "no row goes backward" guarantee and does **not** break on a
   cursor reset. Neuter #1 (guard removed) trips it precisely
   (`fed_ts regressed 1826 → 1825`).

### Teeth-verification ledger (all reverted; file is clean)

| Neuter | Simulates | Assertion that caught it (RED) |
|--------|-----------|--------------------------------|
| #1 — `PgModel.beats → true` | a projection that lost its `fed_ts` guard (the EI-117 revert hole) | watermark `fed_ts regressed` + conflict non-convergence |
| #2 — single bounded pass instead of drain | a merge that truncates a large backfill to the first window | `key-set size mismatch: expected 40 to be 300` |
| #3 — skip peer E's merge | a peer that never converges | `peer E: key-set size mismatch: expected +0 to be 40` |
| (natural) — distinct keys, no conflict | reset replays never reaching the guard | `rejectedByGuard … expected 0 to be greater than 0` (RED in the first run; GREEN once the per-round conflict key was added) |

---

## §live — Live 2-peer backfill-at-size, real binary (su-9140a, attributed) 🟢

On the fresh-boot real-binary pair (`Papercusp_0.0.2` .deb, A=papercupai owner /
B=aviynw joiner, single PUBLIC pot `hello-world-pot`, real testnet DHT, Xvfb
:154), **300 distinct feature rows** were seeded on A (raw PG INSERT origin='local'
→ capture trigger → substrate outbox → drain). B backfilled the **FULL set**
origin='remote' in **~6 s** (t=0 s:0 → t=3 s:200 → t=6 s:300/300), with **300
distinct feature_ids on B = no loss, no duplication** (set-semantics, not a count
re-fold). Crucially this exercises the **real `defaultResolveSwarmBinding` /
joiner-resolves-own-topic path that the in-process rigs bypass — at size.** GREEN —
live backfill scales to a few-hundred-row set with no tail loss; corroborates the
rig's 432-row backfill-at-size case on the packaged binary. (2 identities max on
this box, so N>2 live is impossible — A-NOTE; the rigs own 3–5-peer + churn depth.)

## §real-wire — N-peer content fan-out over the real Hyperswarm 🟢 GREEN

New file:
`packages/operator-core/lib/sync/hyperbee/__tests__/n-peer-content-fanout.integration.test.ts`
(real testcontainer PG + real Hyperswarm over a loopback testnet DHT). Closes the
"no integration test proves content fan-out to N peers" gap that
`cross-peer-coordination-scale` (presence + authority only) left open.

Two tests, both green + teeth-verified:

1. **3-peer content fan-out matrix.** 3 real `bootHarnessSubstrate` Swarms of one
   Pot (the `federatePeerSet(3)` backbone), each authoring a coord-message.
   Asserts the full fan-out **matrix**: every peer's PG holds every peer's message,
   its OWN `origin='local'` and every other's `origin='remote'` (the origin column
   = it genuinely crossed the wire, not a local artifact), plus pre-merge negative
   isolation. Teeth-verified (swap the expected origin → RED; restored → GREEN).
2. **Backfill-at-size over the real wire.** Owner builds a 250-row coord-message
   history on its log; a joiner cold-backfills the **FULL** set (250 distinct ids,
   all `origin='remote'`) within a bounded latency. The real-Hyperswarm + real-PG
   counterpart of the merge-engine 432-row test and the live 2-peer 300-row note.
   Teeth-verified (seed an incomplete history → RED on the completeness poll;
   restored → GREEN). ~1.9 s for 250 rows.

Together the integration layer now proves presence AND content fan-out past 2
peers over the real wire, plus large backfill over the real wire — not just at the
merge-engine model layer.

The brief's live ceiling stands: 3+ **live** peers are unreachable on this box (a
3rd live instance reusing the owner gh identity corrupts admission, A-NOTE), so
3+-peer is the rigs; the live note (§live) covers the 2-peer real-binary path.

---

## Gaps left open (and why)

- **Real-wire content fan-out to N (3+) peers + backfill-at-size over the wire.**
  ✅ CLOSED — see `§real-wire` (`n-peer-content-fanout.integration.test.ts`, two
  tests, green + teeth-verified): the 3-peer fan-out matrix AND a 250-row real-wire
  cold backfill. No residual here.
- **Joiner-resolves-own-topic discovery path.** The in-process rigs bypass
  `defaultResolveSwarmBinding` (they wire matching topics directly), so a scale
  brief must not assume the rigs cover discovery. BUT this is **covered at 2-peer
  scale-at-size by the live note** (§live): the real binary's joiner resolves its
  OWN topic and backfills 300 rows. So the only true residual is the
  joiner-resolves-own-topic path at **N≥3** peers — which is **structurally
  impossible to test live on this box** (2 gh identities; a 3rd reusing the owner
  identity corrupts admission, A-NOTE). Net: covered as fully as the hardware
  allows; the discovery-resolver's own correctness (independent of peer count) is
  Brief L's scope, now GREEN.
- **Clock-skew divergence (D-001).** Deliberately not injected — owned by Brief J.
  These tests assume a correct LWW order and prove scale/churn/size given it.
- **hive_members/hive_settings fan-out (A-003).** Owned by Brief I; those two
  tables are the known non-federating set and are not in this lane's content
  matrix.

## Net

The **scale dimension** is GREEN at the merge engine: N-peer fan-out, churn under
load, and backfill-at-size all converge with no loss/dup and monotonic watermarks,
each property teeth-verified. The release-gating S0/S1s that touch scale
(D-001, A-003) are owned by Briefs J/I; Brief N does not clear them and does not
claim to.
