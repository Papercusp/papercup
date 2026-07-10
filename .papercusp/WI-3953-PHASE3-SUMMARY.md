# WI-3953: Phase 3 DB Rename - Implementation Summary

## Status: ✅ Implementation Complete - Ready for Testing

### Completed Work

#### 1. Database Migration (555-cup-lexicon-db-rename-phase3.sql)
**Location:** `libs/papercusp/libs/db/sql/555-cup-lexicon-db-rename-phase3.sql`

**Scope:** 13 federation-CRUD tables
- `hives` → `pots` (with `home_slug` → `pot_home_slug`)
- `hive_members` → `pot_members`
- `hive_policy` → `pot_policy`
- `hive_settings` → `pot_settings`
- `hive_pending_joins` → `pot_pending_joins`
- `hive_reports` → `pot_reports`
- `cross_hive_asks` → `cross_pot_asks`
- `cross_hive_outbox` → `cross_pot_outbox`
- `cross_hive_beacon_history` → `cross_pot_beacon_history`
- `hive_epoch_keys` → `pot_epoch_keys`
- `hive_directory_cache` → `pot_directory_cache`
- `hive_directory_tombstones` → `pot_directory_tombstones`
- `bee_claim_specs` → `cup_claim_specs` (with `bee_id` → `cup_id`)

**Features:**
- Idempotent: Each rename block uses `IF ... IS NOT NULL AND ... IS NULL` guard
- Atomic: All renames in single transaction
- Constraint handling: Renames + preserves FK relationships
- No compat views: ON CONFLICT cannot target views (unlike Phase 1)

#### 2. Accessor File Updates (9 files)
**Pattern:** `harness_shared.hive_X` → `harness_shared.pot_X`, `hive_home_slug` → `pot_home_slug`

Files updated:
1. `packages/operator-core/lib/hive-store.ts`
   - 11 table references → `pots`
   - 9 column references → `pot_home_slug`
   - 2 critical ON CONFLICT sites

2. `packages/operator-core/lib/hive-membership-store.ts`
   - 13 table references → `pot_members`
   - 12 column references → `pot_home_slug`
   - 1 critical ON CONFLICT (lines 374+)

3. `packages/operator-core/lib/hive-settings-store.ts`
   - 5+ table references → `pot_settings`
   - ON CONFLICT updated

4. `packages/operator-core/lib/hive-policy-store.ts`
   - Updated table/column references
   - ON CONFLICT updated

5. `packages/operator-core/lib/hive-pending-joins-store.ts`
   - Updated table/column references
   - ON CONFLICT updated

6. `packages/operator-core/lib/hive-reports-store.ts`
   - Updated table/column references
   - ON CONFLICT updated

7. `packages/operator-core/lib/cross-hive-asks-pg.ts`
   - Updated table references
   - ON CONFLICT updated (workspace_id, pot_slug, correlation_id)

8. `packages/operator-core/lib/cross-hive-outbox-pg.ts`
   - Updated table references
   - ON CONFLICT updated (workspace_id, pot_slug, id)

9. `packages/operator-core/lib/sync/hyperbee/hive-epoch-keys-store.ts`
   - Updated table references

#### 3. Projection Layer Updates (60+ files)
**Location:** `packages/operator-core/lib/sync/hyperbee/projections/`

All projection files updated with:
- Table name references
- Column name references
- Trigger captures (capture_pot_* functions)
- Federation key references

Key projections:
- `hive-members.ts` → `pot_members`
- `hive-settings.ts` → `pot_settings`
- `hive-policy.ts` → `pot_policy`
- `hive-epoch-keys.ts` → `pot_epoch_keys`
- `hive-pending-joins.ts` → `pot_pending_joins`
- `hive-reports.ts` → `pot_reports`
- `bee-claim-spec.ts` → `cup_claim_specs`

### Testing Checklist

#### Pre-Migration
- [ ] Verify migration file syntax (256 lines, valid SQL)
- [ ] Confirm no migration 555 conflicts
- [ ] Review Phase 1 (WI-3465) gotchas applied:
  - PK/UNIQUE constraint renames auto-rename indexes ✓
  - Live tables may need `SET LOCAL lock_timeout='60s'` (documented in migration)

#### Post-Migration
- [ ] Run `npm run test:affected:integration` 
- [ ] Fix any test failures (likely integration tests with hardcoded table names)
- [ ] Search for hardcoded table references in test files:
  - `grep -r "hive_members" packages/operator-core/lib/**/*.test.ts`
  - `grep -r "hive_settings" packages/operator-core/lib/**/*.test.ts`
  - `grep -r "hive_policy" packages/operator-core/lib/**/*.test.ts`
  - etc.
- [ ] Run `npm run pull-schema.mjs`
- [ ] Verify baseline.sql regenerated correctly
- [ ] Run full test suite

### Critical Files to Watch

**Integration tests** (likely to have hardcoded table names):
- `packages/operator-core/lib/hive-store.integration.test.ts`
- `packages/operator-core/lib/hive-membership-store.integration.test.ts`
- `packages/operator-core/lib/hive-membership-admission.integration.test.ts`
- `packages/operator-core/lib/hive-reports-store.integration.test.ts`
- `packages/operator-core/lib/cross-hive-asks-pg.integration.test.ts`
- Various files under `sync/hyperbee/__tests__/`

**Potential remaining updates:**
- Test fixtures in `sync/hyperbee/__tests__/_hive-substrate-rig.ts`
- Test data builders and mocks
- Hardcoded INSERT statements in test setup

### Known Gotchas & Mitigations

1. **ON CONFLICT constraint**: Cannot target views
   - ✅ Migration creates no compat views for Phase 3 tables
   - ✅ All accessor code uses actual table names

2. **FK cascades**: FK from pot_members → pots
   - ✅ Migration updates FK constraint and name

3. **Trigger renames**: capture_hive_*_outbox_trg → capture_pot_*_outbox_trg
   - ✅ Migration renames all triggers

4. **Policy renames**: hive_members_workspace_isolation → pot_members_workspace_isolation
   - ✅ Migration renames all RLS policies

5. **Index auto-renames**: Constraint renames auto-rename indexes
   - ✅ No redundant ALTER INDEX needed

### Deployment Notes

**Terminal condition (per brief):**
- [ ] WI-3953 done
- [ ] P-009 progressed
- [ ] No lingering old-name views for these 11 tables ✓
- [ ] Tests green

**Coordination:**
- Parallel work: WI-3954 (Phase 2, same fleet, different table scope)
- Prior phase: WI-3465 (Phase 1, done)
- Phase 1 lead: su-9c9b22d6 (available for coordination if needed)

### Next Steps for Test Phase

1. Boot embedded PG: `cd papercusp-desktop && npm run dev`
2. Apply migration: `npm run db:migrate`
3. Run integration tests: `npm run test:affected:integration`
4. Fix test failures (update hardcoded table/column names)
5. Run full suite: `npm run test:affected`
6. Commit via git-sync

### Files Changed Summary

**Schema (1 file):**
- 555-cup-lexicon-db-rename-phase3.sql

**Code (70+ files):**
- 9 accessor files (hive-store, hive-membership-store, etc.)
- 60+ projection files
- Integration test files (TBD based on failures)

**Total lines changed:** ~100+ (mostly table/column name replacements via sed)

---

**Created:** 2026-07-10
**Status:** Ready for testing
**Branch:** staging (shared tree)
