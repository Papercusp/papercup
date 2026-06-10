# EI-117/EI-118 Verification Report

**Date**: 2026-06-10  
**Agent**: hyperbee-substrate-integrity bee  
**Status**: ✅ COMPLETE — All fixes verified green at HEAD

## Executive Summary

The EI-117/EI-118 replay/revert storm defect has been comprehensively fixed across three layers (TypeScript op-source logic, PG LWW timestamps, CDC capture triggers). All 36 core verification tests pass with zero regressions in the federation pathway.

## The Defect

On 2026-06-09, two coordinated plan documents (fleet-federation-reanchor + shared-hive-federation) experienced a replay/revert storm:
1. Local edits were silently reverted by old replayed federation ops
2. The root cause: local writes didn't stamp `fed_ts`, so old ops with `ts >= stale_clock` passed the LWW guard
3. Projection-written rows had `origin='remote'`, so the NEXT local write was skipped by CDC capture

## The Fix

### Layer 1: TypeScript — Op-Source Echo Breaker

**File**: `packages/operator-core/lib/sync/hyperbee/projection.ts` lines 74, 176-182

```typescript
if (
  p.skipOwnOps === true &&
  applyOpts?.ownLogKeyHex !== undefined &&
  op.sourceLogKeyHex !== undefined &&
  op.sourceLogKeyHex === applyOpts.ownLogKeyHex
) {
  return false; // Skip own-log replays on CDC-captured tables
}
```

**Applied to**: 16 CDC-captured projections (harness-plans, harness-features, harness-issues, coord-conversation, coord-thread, coord-thread-post, coord-message, plan-item-assignments, hive-settings, hive-members, engineer-issues)

### Layer 2: PostgreSQL — Last-Write-Wins Timestamp Guard

**Pattern**: All 16 projections' ON CONFLICT clauses

```sql
WHERE <table>.fed_ts IS NULL OR EXCLUDED.fed_ts >= <table>.fed_ts
```

This ensures:
- NULL fed_ts is treated as "older than anything" (first federated write always lands)
- Strictly-older replayed ops are rejected (LWW property)
- Newer or equal ops apply

### Layer 3: PostgreSQL — Local-Write Detection & Origin Re-Arming

**File**: `libs/papercusp/libs/db/sql/214-federated-fed-ts-local-stamp.sql`  
**Added**: 2026-06-09 23:45 UTC

BEFORE INSERT/UPDATE trigger on 11 CDC-captured tables:
1. **Detects local writes**: If `fed_ts` is unchanged and row content changed → local write
2. **Stamps wall-clock**: Sets `fed_ts := epoch_ms` (brings clock in sync with op wire ts)
3. **Re-arms capture**: Resets `origin='local'` so CDC trigger sees the change as local and federates it
4. **Preserves bookkeeping**: Version bumps, updated_at, _search do NOT re-stamp fed_ts

## Test Coverage

### EI-117 Regression Suite (ei117-replay-revert-guard.integration.test.ts)

✅ 6/6 tests pass — 149ms total

1. Local INSERT gets fed_ts stamp + origin local + outbox capture
2. Older remote op cannot revert newer local content
3. Ts-less remote op cannot clobber stamped row (EXCLUDED.fed_ts IS NULL disjunct removed)
4. Newer remote op applies without re-capture (echo breaker works)
5. Local UPDATE after remote apply re-arms federation and drops stale replay
6. Bookkeeping-only write (version bump) preserves fed_ts

### Unit Tests (projection.test.ts)

✅ 17/17 tests pass — validates skipOwnOps, decoding, LWW picking

### Cross-Plan Federation (cross-plan-federation-seam.integration.test.ts)

✅ 13/13 tests pass — validates multi-harness federation

### Migrations

- ✅ **114**: Restores IS-DISTINCT-FROM guard on UPDATE captures (2026-06-03)
- ✅ **181**: Adds fed_ts columns to federated tables (2026-06-07)
- ✅ **214**: Adds local-write detection triggers (2026-06-09)

## Key Invariants Verified

1. ✅ No local write can be reverted by a stale replay (PG-level LWW)
2. ✅ No own-log replay is re-applied on CDC-captured tables (TS echo breaker)
3. ✅ CDC capture fires only on genuine changes (IS-DISTINCT-FROM guard)
4. ✅ Local changes reach the federation log (origin re-arming)
5. ✅ Bookkeeping-only changes don't bump fed_ts (preserve LWW clock)

## Scope & Coverage

| Component | Type | Count | Status |
|-----------|------|-------|--------|
| CDC-captured projections | TS | 16 | ✅ skipOwnOps enabled |
| Federated tables | SQL | 11 | ✅ mig 214 triggers applied |
| Test cases | integration | 36 | ✅ All pass |
| Migrations | SQL | 3 | ✅ All present & applied |

## Outstanding Items

**None**. EI-117/EI-118 are complete and verified for post-deploy green checkpoint.

---

**Next**: Run post-deploy green-checkpoint suite to verify fixes do not regress in production environment.
