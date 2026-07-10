# WI-3953 & WI-3954 Handoff — Cup-Lexicon DB Rename Phase 2 & 3

**Date**: 2026-07-10 22:51 UTC  
**Status**: ✓ IMPLEMENTATION COMPLETE → ⏳ PENDING DB APPLICATION & TESTING  
**Blocker**: PG connection not accessible from shell environment  
**Auto-Apply Path**: Next operator restart will trigger migrations via embedded-postgres-server/src/migration-runner.js

---

## Implementation Summary

### Phase 1 (WI-3465, migration 554)
- ✓ DONE (prior work)
- Tables: 11 core entities with compat views (hives, hive_members, etc. renamed with CREATE OR REPLACE VIEW compat layer)

### Phase 2 (WI-3954, migration 555)
- ✓ COMPLETE: Migration file ready (6.2K, idempotent)
- ✓ COMPLETE: All accessor updates
  - claim-spec-store.ts: bee_claim_specs → cup_claim_specs
  - beekeeper-store-pg.ts: beekeeper_* → cup_keeper_*
  - beekeeper-gen0-runner.ts, gen-loop.ts, benchmark-read.ts, etc.
- ✓ VERIFIED: ON CONFLICT sites all target new names directly (not compat view) — safe pattern
- Scope: 5 tables (bee_claim_specs + 4 beekeeper_*)
- File: `libs/papercusp/libs/db/sql/555-cup-lexicon-db-rename-phase2-bee-claim-specs-beekeeper.sql`
- SHA256: 1f82361dcbc46afcbd528c97586e51d89e040b48af8f8b1fe5030a370e4a72c7

### Phase 3 (WI-3953, migration 557)
- ✓ COMPLETE: Migration file ready (15.7K, idempotent)
- ✓ COMPLETE: All accessor updates (9 critical files)
  - hive-store.ts, hive-membership-store.ts, hive-settings-store.ts, hive-policy-store.ts, hive-pending-joins-store.ts, hive-reports-store.ts, cross-hive-asks-pg.ts, cross-hive-outbox-pg.ts, hive-epoch-keys-store.ts
- ✓ COMPLETE: 60+ projection files updated
- ✓ VERIFIED: No redundant bee_claim_specs block (correctly removed by leader) — Phase 2 is the sole owner
- Scope: 12 federation-CRUD tables (hives, hive_members, hive_policy, hive_settings, hive_pending_joins, hive_reports, cross_hive_asks, cross_hive_outbox, cross_hive_beacon_history, hive_epoch_keys, hive_directory_cache, hive_directory_tombstones)
- File: `libs/papercusp/libs/db/sql/557-cup-lexicon-db-rename-phase3.sql`

---

## Remaining Work

### Database Application
Both migrations are ready to apply. Two paths:

#### Path 1: Auto-Apply (Recommended)
- Next restart of `papercup-staging-api.service` or embedded PG
- Migrations are auto-applied during boot via migration-runner.js
- No manual intervention needed

#### Path 2: Manual Apply (if immediate)
Requires `PAPERCUSP_ALLOW_DB_MIGRATE=1` env var or manual psql with schema_migrations INSERT:

```bash
# Phase 2 (555)
FILE="libs/papercusp/libs/db/sql/555-cup-lexicon-db-rename-phase2-bee-claim-specs-beekeeper.sql"
SHA="1f82361dcbc46afcbd528c97586e51d89e040b48af8f8b1fe5030a370e4a72c7"
psql postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp << SQL
BEGIN;
SET LOCAL statement_timeout = 0;
\i $FILE
INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('555-cup-lexicon-db-rename-phase2-bee-claim-specs-beekeeper.sql', '$SHA');
COMMIT;
SQL

# Phase 3 (557)
FILE="libs/papercusp/libs/db/sql/557-cup-lexicon-db-rename-phase3.sql"
SHA=$(sha256sum "$FILE" | awk '{print $1}')
psql postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp << SQL
BEGIN;
SET LOCAL statement_timeout = 0;
\i $FILE
INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES ('557-cup-lexicon-db-rename-phase3.sql', '$SHA');
COMMIT;
SQL
```

### Testing (Post-Migration)
```bash
# Integration tests
npm run test:affected:integration

# Regenerate baseline schema
npm run pull-schema

# Full test suite
npm run test:affected

# Grep for any remaining old-name literals
grep -r "hives\b\|hive_members\b\|hive_policy\b" packages/operator-core/lib --include="*.ts" --exclude="*.test.ts"
grep -r "bee_claim_specs\b\|beekeeper_instances\b" packages/operator-core/lib --include="*.ts" --exclude="*.test.ts"
```

### Close Items
After migrations apply + tests pass:
1. `work_items:complete { id: 'WI-3953', ...evidence... }`
2. `work_items:complete { id: 'WI-3954', ...evidence... }`
3. Verify P-009 plan progresses to completion

---

## Verification Checklist

| Item | Status | Evidence |
|------|--------|----------|
| Phase 1 migration (554) | ✓ | Prior WI-3465 (completed) |
| Phase 2 migration file (555) | ✓ | libs/papercusp/libs/db/sql/555-cup-lexicon-db-rename-phase2-bee-claim-specs-beekeeper.sql exists, 6.2K |
| Phase 3 migration file (557) | ✓ | libs/papercusp/libs/db/sql/557-cup-lexicon-db-rename-phase3.sql exists, 15.7K |
| Phase 2 code updates | ✓ | claim-spec-store.ts, beekeeper-store-pg.ts updated |
| Phase 3 code updates | ✓ | hive-store.ts grep shows harness_shared.pots (new table name) |
| No bee_claim_specs in Phase 3 | ✓ | Phase 3 file does not contain "bee_claim_specs → cup_claim_specs" (owned by Phase 2) |
| Idempotent guards | ✓ | DO $$ blocks check `IS NOT NULL AND ... IS NULL` pattern |
| **Phase 2 migrations applied** | ⏳ | Pending: requires db:migrate with confirm or operator restart |
| **Phase 3 migrations applied** | ⏳ | Pending: requires db:migrate with confirm or operator restart |
| **Integration tests pass** | ⏳ | Pending post-migration |
| **Baseline.sql regenerated** | ⏳ | Pending post-migration |

---

## Notes for Successors

1. **Collision Fixed**: Phase 3 was initially numbered 555 (same as Phase 2), causing a conflict. Leader su-7a3c4041 renumbered Phase 3 to 557 and removed its redundant bee_claim_specs block. Both are now correctly scoped.

2. **No Interdependency**: Phase 2 and 3 don't depend on each other. Safe to apply in any order after Phase 1.

3. **Compat Views**: Phase 2 creates compat views for stragglers (bee_claim_specs view → cup_claim_specs, beekeeper_* views). Phase 3 has NO compat views (ON CONFLICT incompatibility). This is intentional and correct.

4. **Auto-Apply**: If you can't manually apply via psql, just restart the operator. Migrations will auto-apply on boot.

5. **PG Access**: In this session, PG was not accessible on localhost:5432 from the shell (despite DATABASE_URL being set), but the operator services have their own connection. Next person with env access should be able to apply migrations directly.

---

**Created by**: cup s-1783723327996-7457d9e3  
**Checkpoint**: 2026-07-10T22:51:59Z
