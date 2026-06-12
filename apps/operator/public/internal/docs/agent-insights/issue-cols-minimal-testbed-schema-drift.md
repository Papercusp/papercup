# Adding a column to ISSUE_COLS/FEATURE_COLS breaks minimal-schema integration testbeds — patch every 131-applier, not just your own suite
URL: /internal/docs/agent-insights/issue-cols-minimal-testbed-schema-drift

Several integration suites hand-assemble engineer_issues from picked migration files (131 + ad-hoc ALTERs). A new column selected by ISSUE_COLS (issues-engineer.ts) fails them all with "column does not exist" — grep for 131-engineer-issues.sql and apply your migration in each setup.

## Symptom

`npm run test:affected:integration` goes red with 10+ tests across suites you
never touched — `delegated-tasks`, `plan-items/plan-item-convert`, the four
`shared-hive-loop` suites — all with the same error:

```
PostgresError: column "signal_origin" of relation "engineer_issues" does not exist
  ❯ createIssue lib/issues-engineer.ts:249
```

Your own suite (and the live DB) are green, because you applied your migration
there. The failures are NOT in your test; they are in the **work-items engine
code path** (`ISSUE_COLS` / `FEATURE_COLS` in
`packages/operator-core/lib/issues-engineer.ts`), which now selects/inserts a
column the other suites' test DBs don't have.

## Root cause

These suites do not provision through the full migration chain. They build a
**minimal schema** by applying hand-picked migration files plus ad-hoc
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` patches:

* `lib/plan-items/plan-item-convert.integration.test.ts` (beforeAll,
  `readMigration('131-engineer-issues.sql')` + selected others)
* `lib/delegated-tasks.integration.test.ts` (same pattern)
* `lib/shared-hive-loop/composition-rig.ts` (a file list around line 270 —
  shared by composition-happy-path, fleet-monitors, redundancy-two-swarm,
  split-brain-queen)

So any migration that adds a column **the engine reads or writes
unconditionally** must also be applied in every one of these setups. This has
now recurred twice: migration 178 (`assignee_rank` — the precedent is the
inline ALTER comment in those same beforeAlls) and migration 241
(`signal_origin`, fixed 2026-06-12 during consume-edges B-09).

## Fix / rule

When you add a column to `engineer_issues` / `harness_features_consolidated`
that `ISSUE_COLS`/`FEATURE_COLS` (or any unconditional engine SQL) touches:

```bash
grep -rln "131-engineer-issues.sql" packages/operator-core/{lib,test}
```

and add your migration to **each** hit (one line, mirroring the existing
pattern):

```ts
// Signal provenance (frontier P-002, migration 241): ISSUE_COLS selects signal_origin.
await db.sql.unsafe(readMigration('241-signal-provenance-origin.sql')).simple();
```

(`composition-rig.ts` takes the filename in its list instead.) Then run the
hits' suites, not just your own:
`npx vitest run --config vitest.integration.config.ts <files>`.

Keep migrations like this **idempotent + standalone** (ADD COLUMN IF NOT
EXISTS, no `\set`, no BEGIN/COMMIT wrappers) — the rig strips psql
meta-commands but can't fix a migration that depends on later files.
