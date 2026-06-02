---
title: Self-contained migration baseline + ensure-schema removal + integration-test tier
slug: self-contained-migration-baseline-2026-06-02
status: active
created: 2026-06-02
updated: 2026-06-02
owner: avi@storewolf.com
---

# Self-contained migration baseline + ensure-schema removal + integration-test tier

> **Design spec:** `docs/superpowers/specs/2026-06-02-self-contained-migration-baseline-design.md` (committed `3fe6fe738`).
> Each item (P-NNN) is a self-contained unit; phases are sequential. Implement task-by-task with per-turn commits on `main`.

## Now

**State:** Design approved + spec committed (`3fe6fe738`). Plan authored; **no code written yet.** This resolves
`production-readiness-test-coverage-2026-05-30` **D-005** (owed migration-baseline rebuild) and unblocks +
populates **P-002 / P-015 / P-016 / P-017** (integration tier) there. Locked decisions D-001..D-006 below.
⚠️ The `sql/` dir + `libs/papercusp` submodule has live churn from peers (097/098 boot-crash fixes landing
now) — `coord:declare-intent` + `locks:acquire` on `libs/papercusp/libs/db/sql/` before the squash, and
freeze 001–103 only once that churn settles.

**Next:** Start Phase 0 **P-001** — resolve the all-ensures invocation mechanism for the reference-build
generator (tsx codegen entrypoint importing the 65 exported `ensureXxx()` vs. boot-and-trigger).

## Background

The schema is built by two un-unified sources, so `empty PG → migrations → head` does not produce a working
schema: (1) 115 hand-written SQL migrations build a fraction of `harness_shared`; (2) `ensure-schema.ts`
(+ dogfood + an `autoloop` inline CREATE) creates ~78 `harness_shared` tables (plus 62 indexes, 43 ALTERs,
6 RLS policies, 1 trigger) **lazily at runtime**. Drizzle (`generated.reference.sql`) and the seed dump are
downstream reflections, not sources of truth. Investigation 2026-06-02 (empty→head on a scratch DB): 105
applied, 6 `42P01` skips (ensure-schema tables), 3 re-thrown failures (`016` = probe-artifact superuser; `098`
= cascade of `097`/feature_queue; `081` = `vector` type/search_path). This plan makes **migrations the single
source of truth**, then stands up the integration tier. See the spec for full investigation detail.

## Phase 0 — Reference-build generator (the oracle)

- **P-001** `todo` Resolve the all-ensures invocation mechanism: a `tsx` codegen entrypoint inside `apps/operator` importing all 65 exported `ensureXxx()` + the dogfood/autoloop ensures, vs. booting an operator sidecar against a scratch DB and triggering an ensure-all path. Acceptance: a documented, runnable approach that creates every `harness_shared` table/index/policy against a given DSN.
- **P-002** `todo` Write `libs/papercusp/libs/db/scripts/build-reference-schema.mjs` (sibling to `pull-schema.mjs`): scratch PG → framework roles + extensions (`pgcrypto`,`pg_trgm`,`vector`) → apply all 115 migrations (tolerating current 42P01 skips) → invoke all ensures (per P-001) → `pg_dump --schema-only --schema=harness_shared --schema=papercup_shared`. Acceptance: emits a complete raw schema dump of a fully-built DB. blocked-by P-001.
- **P-003** `todo` Sanitizer that transforms the raw dump → idempotent `000-baseline.sql`: `CREATE TABLE/INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS`+`CREATE POLICY`, DO-block guards; strip ownership/GRANT/role/SET noise. Unit-test the transform (`*.test.ts`). Acceptance: applying the output twice against an empty DB is a clean no-op on the second run. blocked-by P-002.

## Phase 1 — Land the baseline (app still works)

- **P-004** `todo` Move framework-role + `BYPASSRLS` + extension creation into the embedded-pg **boot** pre-migration step (`embedded-postgres-server/src/index.js`, mirroring the existing role bootstrap). Acceptance: a fresh boot creates roles + the 3 extensions before running migrations.
- **P-005** `todo` Add `000-baseline.sql`; move the 115 incrementals (001–103 incl. lettered sub-files) → `libs/papercusp/libs/db/sql/archive/`; **keep** `002-per-harness-template.sql`; new migrations continue at `104+`. Acceptance: runner glob applies only `000-baseline.sql` (+ template skipped as before). blocked-by P-003, P-004.
- **P-006** `todo` **Verification gate (LINCHPIN):** schema-diff a fresh-from-`000-baseline.sql` DB against the reference-built DB (migra or normalized `pg_dump` diff). Must be **identical**. This is the hard precondition for Phase 2. Acceptance: zero schema diff (tables, columns, indexes, policies, triggers). blocked-by P-005.
- **P-007** `todo` Commit Phase 1; confirm deployed-DB safety — applying `000-baseline.sql` to the already-populated live native `:5432 papercusp` DB is a no-op and gets marked applied. Acceptance: live DB unchanged, baseline row recorded. blocked-by P-006.

## Phase 2 — Delete ensure-schema (proven redundant)

- **P-008** `todo` Delete `apps/operator/lib/ensure-schema.ts` + `ensure-schema-dogfood.ts` + the `autoloop.ts` inline CREATE; remove all 54 operator call sites (the `await ensureXxx()` guard + import at each). **Keep** generic-lib ensure APIs (`@papercusp/coordination/*`) — the operator just stops calling them. Acceptance: 0 references to the deleted symbols; `tsc` clean. blocked-by P-006.
- **P-009** `todo` Remove the migration runner's `42P01`-tolerance (`migration-runner.js`) so empty→head applies with **zero skips**. Acceptance: a real `42P01` now throws (regression guard for the original token_index bug stays loud). blocked-by P-006.
- **P-010** `todo` Re-verify: Tauri desktop boot + core-flow smoke per `/internal/docs/testing` + `agent-e2e` (the app works with no lazy ensures); `npm run test:affected`. Acceptance: desktop boots, core flows green. blocked-by P-008, P-009.

## Phase 3 — Strict gate + regen + governance

- **P-011** `todo` Replace `apps/operator/test/fresh-migrate.integration.test.ts` tripwire with the STRICT SUCCESS GATE already sketched in that file: clean apply from empty + idempotent re-run (second run applies 0) + one tracker row per migration. Acceptance: gate green. blocked-by P-009.
- **P-012** `todo` Refresh Drizzle via `pull-schema.mjs` against a baseline-built DB; expect ≈ no-op diff; commit refreshed `schema.ts`/`generated.reference.sql`. Acceptance: types compile, diff explained. blocked-by P-006.
- **P-013** `todo` Retire seed-restore: remove the `PAPERCUSP_PG_SEED_DUMP_PATH` seed-restore branch from the embedded-pg boot; measure fresh-boot time. Acceptance: fresh embedded-pg boot builds the full schema via the baseline within acceptable time (record the number). blocked-by P-005.
- **P-014** `todo` Governance docs: schema changes = a new migration (`104+`), **no runtime DDL**, run `pull-schema.mjs` after migrating. Update `system/storage-policy.mdx` + `CLAUDE.md` + testing docs (new-table workflow: "add an ensure fn" → "add a migration"). Acceptance: docs build; the old ensure-schema workflow is removed from guidance.

## Phase 4 — Integration tier (the payoff)

- **P-015** `todo` (production-readiness **P-002**) Vitest `globalSetup` that boots a testcontainers PG, creates roles + extensions, and applies `000-baseline.sql` once per run → full schema for the integration tier. Acceptance: an integration test can query any `harness_shared` table. blocked-by P-005, P-011.
- **P-016** `todo` (production-readiness **P-015/016/017**) Author the integration tool-suite tests on top of the working globalSetup. Acceptance: the tool suites run against a real full schema and are green. blocked-by P-015.
- **P-017** `todo` (production-readiness **P-006**) Run the full integration suite once; convert never-executed surfaces into an honest red/green + coverage baseline; file real failures as issues. Acceptance: suite runs end-to-end. blocked-by P-016.

## Decisions

### D-001 — Squash to one idempotent baseline
2026-06-02. Replace the 115 incrementals with one idempotent `000-baseline.sql`; archive 001–103. Alpha + no users makes rewriting migration history safe, and it eliminates the entire "ALTER on an ensure-schema table" boot-crash class (the 097/098 incidents).

### D-002 — Delete ensure-schema entirely
2026-06-02. Remove operator code: 65 `ensureXxx` fns + 54 call sites + the dogfood ensures + the `autoloop` inline CREATE. The generic borrowable libs' ensure APIs (`@papercusp/coordination/*`) stay — other host projects consume them.

### D-003 — Clean reference build is the baseline source + oracle
2026-06-02. The baseline is generated by applying all migrations + invoking all ensures against a scratch DB, then `pg_dump` — not by dumping the live box (dirty/transient state). The same reference DB is the verification oracle for P-006.

### D-004 — Retire the seed-restore path
2026-06-02. With one fast idempotent baseline file, the migration runner is the fresh-boot path; the second schema source (the seed dump) is removed. Regenerate the dump only as a fallback if boot time measurably regresses (P-013).

### D-005 — Schema-diff gate precedes the deletion
2026-06-02. The Phase-1 schema-diff gate (P-006) is the hard precondition for the ensure-schema deletion (Phase 2). No deletion until a fresh-from-baseline schema is identical (modulo ordering) to the reference-built schema.

### D-006 — Full scope through the tool-suite tests
2026-06-02. This effort runs through authoring the integration tool-suite tests (production-readiness P-015/016/017), not just unblocking them.
