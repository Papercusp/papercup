# Brief Z — Data-integrity edges (findings)

**Owner:** su-d2230 (the del-guard / delete-resurrection class is mine — Z is built on it).
**Status:** IN PROGRESS. Claimed while A-003 send-side waits on J's announce extension
(I pivot to the A-003 re-apply the instant it lands — that's the critical path).
**Verdict so far:** one **grounded S0 HYPOTHESIS** (resurrection-after-restart) staged for
a teeth-verified integration test; payload/encoding/boundary legs not yet run.

---

## H-Z1 (S0 hypothesis): stale-PUT-after-DELETE resurrection across a cursor reset

### The invariant Z must hold
A federated DELETE that causally supersedes a PUT must leave the row **gone on every
peer and STAY gone** — a later-*arriving* but causally-*earlier* (lower-HLC) put must NOT
resurrect it.

### What the code actually does (grounded, not speculative)
1. **The DELETE is guarded** (`projection.ts` deleteFromPg, EI-79 + D-001): the deleter's
   `DELETE ... WHERE fed_hlc/fed_ts <= delHlc/delTs` ensures a stale DEL can't erase a
   row a *newer* put recreated. ✓ This direction is protected, PG-level, fold-independent.
2. **There is NO tombstone.** A del does a bare `DELETE` (row removed). The PUT guard is
   `INSERT ... ON CONFLICT(key) DO UPDATE ... WHERE EXCLUDED.fed_hlc >= fed_hlc`. After a
   del the row is **absent** → a subsequent put hits **no conflict** → the INSERT plainly
   succeeds. Nothing records that a *higher-HLC del already won* this key.
3. **The only thing preventing resurrection is the merge cursor's in-memory `winners`**
   (`read-merge.ts` lwwPick fold) — when del+put are folded together it picks the del and
   never applies the put. But the cursor is **created fresh on every boot**
   (`boot.ts:841 createMergeCursor()`) and reset on full re-fold (`boot.ts:1092`).

### The resurrection scenario (S0 if it reproduces)
1. DEL (HLC=high) for key K applied → row gone; cursor.winners[K]=del (this process only).
2. **RESTART** → cursor reset (winners empty); positions re-seeded from snapshots, so
   already-processed ops are not re-folded.
3. A **delayed/late PUT (HLC=low)** for K — e.g. from a slow/just-healed peer — arrives as
   a NEW op past the seeded offset. Its fold has empty winners (no del) → the put is K's
   only op this fold → applied → PG has no row + no tombstone → **INSERT → RESURRECTION**.

The fold protects this WITHIN one process lifetime; it does **not** survive the
cursor-reset boundary, and PG has no durable guard for the put-after-del direction. This
is the same restart-cursor-reset seam I flagged in the A-003 option-(b) analysis.

### Test plan (next step — teeth-verified integration)
- Integration test (real PG via the value mappers + the real projection writers, pattern
  from `register-all-hive-home-binding.integration.test.ts` / `createOrgTestDb`): for each
  mutable type — apply DEL(hlc=high) → assert row gone → apply PUT(hlc=low) **through a
  FRESH cursor** (models the restart) → assert row **STILL GONE** (no resurrection).
- Expected: **RED today** (resurrects — no tombstone) for at least the simple put path →
  confirms the S0. If it stays GREEN, locate the durable guard I missed + document it.
- Teeth: a passing guard must go RED when the guard/tombstone is neutered.
- Property leg: extend `_convergence-fuzz-rig.ts` with a **restart event** (reset the
  cursor mid-stream, keep the store) + assert no key resurrects across it.

### If confirmed — the fix shape (for the owner/lead, not unilateral)
A durable per-key **tombstone with the del's HLC** (a `deleted_at_hlc` column kept on a
soft-deleted row, or a tombstone side-table) that the PUT guard checks
(`WHERE EXCLUDED.fed_hlc >= COALESCE(row.fed_hlc, row.tombstone_hlc)`). GC tombstones past
a safe horizon. This makes put-after-del PG-level LWW, fold-independent — the mirror of
what EI-79/D-001 already did for the del-after-put direction.

---

## Remaining Z legs (not yet started)
- Z#3 tombstone propagation / `leave-hive` + contributor-tombstone under churn.
- Z#4 large/binary payload round-trip (find the ceiling; graceful failure past it).
- Z#5 encoding/unicode/NUL/RTL/emoji round-trip through capture→drain→projection.
- Z#6 empty/null/boundary fields + numeric extremes (the B-001 column-completeness class).
