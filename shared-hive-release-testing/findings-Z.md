# Brief Z — Data-integrity edges (findings)

**Owner:** su-d2230 (the del-guard / delete-resurrection class is mine — Z is built on it).
**Status:** H-Z1 **CONFIRMED S0 → FIXED + VERIFIED** (found+proved su-53f39 2026-06-19;
EI-1688; fixed by c2a63 via the snapshot del-tombstone — no PG migration — and verified
green by the proof test snapshot-stale-resurrection-s0.test.ts: S0-FIXED + CONVERGENCE).
Z#3 done (the blast-radius matrix, on EI-1688). Z#4/Z#5 = LOW-sev self-healing NUL nit
(characterized below). Z#6 not run (low priority).
**Verdict:** **S0 CONFIRMED — snapshot-seeded folds PERMANENTLY resurrect a key deleted
before the snapshot** when a stale lower-clock put arrives past the snapshot horizon. The
read-merge "BOUNDED TRANSIENT" (put-after-del has no PG tombstone) is NOT bounded with
`papercusp-substrate-log-snapshot` ON (verified ON). Proof:
`__tests__/snapshot-stale-resurrection-s0.test.ts` (PG-free, deterministic): a full fold
from 0 keeps the deleted key absent (del wins); the production snapshot-seeded fold
RESURRECTS it (the winning del sits behind the snapshot horizon, never re-folded; no
tombstone; the PG PUT guard fires only ON CONFLICT so a bare INSERT succeeds).
**Security interaction:** a resurrected `hive_members`/revoked-pubkey row would UN-REVOKE a
removed member — couples directly to C-001 (read-revocation / Brief K re-key). Filed as a
work-item; fix is the owner/lead's call (durable per-key del-HLC tombstone the PUT guard
checks, GC'd past a safe horizon) — NOT applied unilaterally.

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

## Z legs — progress (su-53f39, 2026-06-19)
- **Z#1 → CONFIRMED S0 = EI-1688** (snapshot-seeded resurrection; see Status above + the blast-radius matrix on EI-1688). The centerpiece "S0 if resurrection" finding.
- **Z#3 (tombstone / delete-shape audit) → done as the EI-1688 blast-radius matrix:** ~19 of 21 federated projections delete via a bare `DELETE` (all resurrectable); feature-claims is append-only (never-delete model); full per-type list on EI-1688. (Tombstone-under-churn behavior is moot until the EI-1688 fix lands.)
- **Z#4 / Z#5 (large/binary payload + encoding/unicode/NUL) → LOW-severity nit, NOT an S1:**
  the severe "poison-pill federation stall" hypothesis was REFUTED by test. A NUL (0x00) in a
  string field (no sanitization in the value path; PG rejects it in TEXT + JSONB; applyOpVia +
  the merge have no try/catch around apply) causes a TRANSIENT throw on the first merge pass that
  reaches it — but `cursor.winners` records the op BEFORE the throwing apply, so the NEXT pass
  skips it via stale-dedup and the merge SELF-HEALS (later good ops apply; the NUL op's content is
  never stored, which is consistent across peers since PG can't hold a NUL). Net: an avoidable
  transient error + log noise per restart, not a stall or divergence. Proof:
  `__tests__/poison-op-merge-stall-s1.test.ts`. Recommendation (low priority): sanitize NUL at the
  value boundary, or quarantine a throwing apply (record + skip, no throw) — adjacent to the
  EI-1688 merge-apply work, flagged to c2a63. Large/non-NUL payloads + RTL/emoji round-trip
  untested but lower-risk (jsonb/text handle them); the NUL edge was the real risk and is now
  characterized.
- **Z#6 (empty/null/boundary fields, numeric extremes) → not yet run** (low priority; the
  column-completeness class is partly covered by the B-001 work + existing projection tests).
