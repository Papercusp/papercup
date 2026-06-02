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

**State (2026-06-02, autonomous loop):** **Phase 0 COMPLETE + the Phase-1 diff-gate (P-006) is GREEN.**
- **P-001/P-002 done** — reference-build generator `apps/operator/lib/db-tools/build-reference-schema.ts`
  (commit `30324d250`, augmented `c00c0f3a7`). It now produces the **COMPLETE 184-table** `harness_shared`
  schema (was 170) by also applying the 2nd migration system + a captured fragment (see D-007/D-008).
- **P-003 done** — `apps/operator/lib/db-tools/sanitize-baseline.ts` (+ 18 unit tests, commit `510e82ca5`):
  raw `pg_dump` → idempotent `000-baseline.sql`. Zero unknown statement shapes on the real dump.
- **P-006 PROVEN GREEN (the linchpin):** a fresh DB built from `000-baseline.sql` **alone** is schema-IDENTICAL
  (0-line normalized diff) to the full reference build, AND double-apply is a clean no-op (0 errors). Proof
  artifacts in `/tmp/baseline-proof/`. **This is the hard precondition that authorizes Phase 2 deletion.**

⚠️ **Scope expanded vs the spec's "2 sources":** the schema is built by ~6 fractured sources, and the 14 ghost
tables fall into 3 groups (see D-007). Phase 2's "delete ensure-schema + 54 call sites" is bigger — a whole
2nd migration system (`apps/operator/lib/commands/migrations/`, 15 files), orchestrator-package inline creators
(`*-pg.ts`), endpoint-route inline creators, and feature-module inline creators all create tables at runtime too.

⚠️ `sql/` churn is **ongoing** (104/105/106 landed since the spec; peers reconciling 097-106 across native+embedded).
Lock `libs/papercusp/libs/db/sql/` for the squash (P-005); new migrations stay 107+ so they don't conflict with archiving 001-106.

**DONE (all committed):** P-001/002/003 (generator+sanitizer), P-004 (boot roles+ext), P-005 (squash), P-006 (diff gate + `verify-baseline.ts`), P-007 (deployed-safety; live drift flagged), **P-008 (ensure-schema.ts deleted, 63 call sites)**, **P-008b-dogfood (ensure-schema-dogfood.ts deleted, 6 consumers)**, P-009 (42P01 removed), P-011 (STRICT GATE 9/9 + pgvector image), **P-013 (seed-restore retired, D-004)**, P-014-core (governance docs), **P-015 (integration globalSetup + proof test)**.

**3 COMPLETENESS GAPS the original reference-build/diff-gate MISSED (scoped to 2 schemas + `--no-privileges`, no trigger diff) — all closed by forward migrations + the gates hardened to guard them:**
- **107** — dogfood reactivity triggers (`emit_change_notify_trg` ×18) were runtime-only.
- **108** — P-070 `contributor_usage_events.origin` + capture triggers (incl. an `INSERT OR DELETE`→`+UPDATE` def reconcile on the 2 consolidated tables).
- **109** — core global schemas `papercusp_auth` + `audit` (the 2-schema dump omitted them) + **all role GRANTs** (the `--no-privileges` dump dropped them; a fresh boot would've locked `harness_app` out).
`verify-baseline.ts` + the strict gate now assert tables + triggers + schemas + harness_app grants.

**INTEGRATION-TIER VALIDATION (P-016/017):** ran the full integration suite (407 tests). The squash/schema-completion surfaced + I fixed every failure my work *caused*: `_org-test-db` (needed extensions + was swallowing migration errors → built no schema), tests reading individual migrations now in `archive/` (substrate-outbox-trigger, feature-content-federation, harness-plan-status-grants → `archive/` paths), `read-frontier-features` (null→'local' origin, real schema is NOT NULL), `feature-lifecycle-pg` (added the consolidated stub the auditor LEFT JOIN needs), and — the big one — `getTestPg` now **heals the cluster-global framework roles** (create-or-fix login+password): the shared/reused container + tests that created `harness_app` password-less had left a stale role breaking every password-login test (exposed when the P-011 pgvector image reset the reused container). Residual failures are **pre-existing, NOT from this plan**: the drizzle-under-vitest `is()` null-constructor bug (`list-workspaces`; `schema.ts` unchanged here), the P2P hyperbee swarm not initializing in-container (`feature-content-federation` Stage-6), and the e2e "Papercup principal not provisioned" suite (needs a provisioned principal/server).

**REMAINING:**
- **P-008b-remainder:** the OTHER inline runtime creators — orchestrator `*-pg.ts`, endpoint-route (`hidden_plugins`/`operator_budget_tiers`/`operator_settings`), feature-module (`voice-lease`/`operator-claims`/`harness-prompt-overrides`/`plugin-grants`/`plugin-audit-writer`/`ensure-git-outbox`), and the 2nd migration system (`lib/commands/migrations/` + `audit-writer.ts`). Their tables are in the baseline; per-creator verify (build migrations-only vs migrations+invoke-creator, diff) before removing.
- **P-010:** Tauri desktop boot smoke (own Xvfb).
- **P-012:** drizzle regen via pull-schema.mjs against a baseline-built DB (pick up 108's `origin` col + auth/audit).
- **P-014-html:** rebuild operator-docs html mirror.
- **P-016/017:** the handler-level tool-suite tests already exist; optionally upgrade to globalSetup full-schema + run the full integration suite once.

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

- **P-001** `done` Mechanism resolved: a `tsx` entrypoint **inside `apps/operator`** (`lib/db-tools/build-reference-schema.ts`) that imports `@/lib/ensure-schema` (65 exported `ensureXxx()`, multi-pass) + dogfood + autoloop. Runs against a testcontainers pgvector DSN. (Placed in `apps/operator`, not `libs/papercusp/.../scripts`, for `@/` + `@papercusp/*` module resolution.)
- **P-002** `done` `build-reference-schema.ts` (commit `30324d250`; augmented `c00c0f3a7`): scratch pgvector → roles + extensions → apply all migrations (42P01-tolerant) → all ensures → **also apply the 2nd migration system (`lib/commands/migrations/*.sql`) + `baseline-extra-tables.sql`** → `pg_dump`. Emits the **complete 184-table** schema (verified exact match to live ∪ {memory_feedback,tool_authz_log}, 0 missing/0 extra).
- **P-003** `done` `sanitize-baseline.ts` (commit `510e82ca5`, 18 unit tests): dollar-quote-aware splitter + per-keyword idempotency rules (`IF NOT EXISTS`, `OR REPLACE` fn/trigger/view, `DROP POLICY IF EXISTS`+`CREATE`, DO-block constraint guards tolerating duplicate_object/_table/**invalid_table_definition** (PK re-add = 42P16), keep idempotent ALTERs, drop SET/set_config + PG18 `\restrict`/`\unrestrict`). **Verified: double-apply on a fresh DB = 0 errors (idempotent).** Unknown shapes are flagged, not silently dropped.

## Phase 1 — Land the baseline (app still works)

- **P-004** `todo` Move framework-role + `BYPASSRLS` + extension creation into the embedded-pg **boot** pre-migration step (`embedded-postgres-server/src/index.js`, mirroring the existing role bootstrap). Acceptance: a fresh boot creates roles + the 3 extensions before running migrations.
- **P-005** `todo` Add `000-baseline.sql`; move the 115 incrementals (001–103 incl. lettered sub-files) → `libs/papercusp/libs/db/sql/archive/`; **keep** `002-per-harness-template.sql`; new migrations continue at `104+`. Acceptance: runner glob applies only `000-baseline.sql` (+ template skipped as before). blocked-by P-003, P-004.
- **P-006** `done` **Verification gate (LINCHPIN) — PROVEN GREEN 2026-06-02.** Built a fresh DB from `000-baseline.sql` alone (roles+ext, then the file), dumped it with generator-matching flags, normalized both (strip `\restrict` keys/comments/SET), and `diff`ed against the reference build → **0-line diff (identical)**. Double-apply = 0 errors. Proof in `/tmp/baseline-proof/`. (Logic to be formalized as a repeatable tool + folded into P-011's strict gate.) This authorizes Phase 2.
- **P-007** `done-with-caveat` Deployed-DB safety **PROVEN for coherent DBs**: re-applying `000-baseline.sql` to the complete reference-built DB = **0 errors** (the canonical "already-populated" case). ⚠️ **Caveat — the live native `:5432` box is NOT coherent:** applying the baseline to a *copy* of it errors `column "agent_backend" does not exist` because the live `delegates` table is **missing `agent_backend`** — the untracked 2nd-migration-system file `008_delegate_agent_backend.sql` was never run here (exactly the manual-DDL fragility this plan removes). This is **pre-existing drift**, not a baseline defect; the baseline correctly carries the complete schema. **Deliberately NOT mutating the live DB** (shared box; would also add 099-101 RLS policies + the missing tables = real access-control change, needs supervised reconciliation). The squash doesn't worsen it (native `:5432` has no auto-runner). Baseline intentionally NOT weakened to mask drift. blocked-by P-006.

## Phase 2 — Delete ensure-schema (proven redundant)

- **P-008** `done` (core) Deleted `ensure-schema.ts` (65 fns) + the transient generator + autoloop inline CREATE; removed all **63 call sites** (commit `1b91b567b`). 0 dangling refs; tsc ZERO new errors (563→561, deltas are pre-existing postgres-js `sql<T>` typing); coordination/backup host-seams rewired to no-op `ensureSchema:async()=>{}`; sanitize 18/18. **KEPT `ensure-schema-dogfood.ts`** — its `wireDogfoodTriggers()` wired `emit_change_notify_trg` reactivity triggers on 18 tables that were in NO migration (the diff gate doesn't diff triggers → missed it). **Fixed by migration 107** (`9b77099`, CREATE OR REPLACE TRIGGER ×18) — now migration-sourced + asserted by verify-baseline + the strict gate (both ≥18). Dogfood is now fully redundant (tables in baseline, triggers in 107) → safe to delete in the expanded pass.
  - **P-008b** `todo` (expanded scope — separate pass) Remove the remaining runtime DDL now that its tables/triggers are all baseline+107-sourced: `ensure-schema-dogfood.ts` + consumers, the 2nd migration system (`lib/commands/migrations/*.sql` + `audit-writer.ts`), orchestrator `*-pg.ts` creators, endpoint-route + feature-module inline creators (voice-lease, operator-claims, harness-prompt-overrides, plugin-grants, plugin-audit-writer, ensure-git-outbox). Each: remove the `CREATE TABLE` + guard, verify tsc + verify-baseline.
- **P-009** `done` Removed the migration runner's `42P01`-tolerance (`migration-runner.js`, submodule `3568195`). Empty→head now applies with **zero skips**; any error throws loudly. Verified by verify-baseline (still green, no skips) + the P-011 strict gate.
- **P-010** `todo` Re-verify: Tauri desktop boot + core-flow smoke per `/internal/docs/testing` + `agent-e2e` (the app works with no lazy ensures); `npm run test:affected`. Acceptance: desktop boots, core flows green. blocked-by P-008, P-009.

## Phase 3 — Strict gate + regen + governance

- **P-011** `done` Replaced the `fresh-migrate.integration.test.ts` tripwire with the STRICT SUCCESS GATE: empty→head applies with zero skips, ≥184 harness_shared tables, one tracker row per migration, idempotent 2nd run, raw baseline re-apply no-op, filename-keyed PK safety. **6/6 green** vs a real pgvector container. Also switched `@papercusp/test-config` `getTestPg` → `pgvector/pgvector:pg16` (test-config submodule `4ab9097`) so the tier can build the baseline's `vector(N)` columns (unblocks P-015).
- **P-012** `todo` Refresh Drizzle via `pull-schema.mjs` against a baseline-built DB; expect ≈ no-op diff; commit refreshed `schema.ts`/`generated.reference.sql`. Acceptance: types compile, diff explained. blocked-by P-006.
- **P-013** `todo` Retire seed-restore: remove the `PAPERCUSP_PG_SEED_DUMP_PATH` seed-restore branch from the embedded-pg boot; measure fresh-boot time. Acceptance: fresh embedded-pg boot builds the full schema via the baseline within acceptable time (record the number). blocked-by P-005.
- **P-014** `todo` Governance docs: schema changes = a new migration (`104+`), **no runtime DDL**, run `pull-schema.mjs` after migrating. Update `system/storage-policy.mdx` + `CLAUDE.md` + testing docs (new-table workflow: "add an ensure fn" → "add a migration"). Acceptance: docs build; the old ensure-schema workflow is removed from guidance.

## Phase 4 — Integration tier (the payoff)

- **P-015** `done` (production-readiness **P-002**) `test/setup/baseline-schema.globalSetup.ts` (commit `e245960a3`) — boots a dedicated pgvector container, creates roles+ext, applies the full migration set (000-baseline+107+108), exposes the DSN via `inject('baselineSchemaDsn')`. Proof test (5) + verified coexisting with fresh-migrate + read-tools (36 green, no teardown race). Owns its own container to avoid the per-file `teardownTestPg` stop/recreate race. **Also: migration 108** (`9ee0b57`) closed the last dogfood-vs-migrations gap (contributor_usage_events.origin + 3 capture triggers; found by `dogfood-gap-check.ts`, now 0) → **dogfood is provably redundant + safe to delete (P-008b).**
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

### D-007 — Live-DB dump REJECTED as baseline source; reference build is the base (revises D-003/D-004 premise)
2026-06-02. Phase 0 revealed the clean reference build (D-003/D-004) was *incomplete* (170 tables; live has 184) — but the proposed fix of "dump the live DB" is **wrong here**: this dev box's native `:5432 papercusp` is in a *partial* migration state (tracker shows 098-101 + 104-106 UNAPPLIED; only 102/103 on top of ~097), and the reference build even has 2 tables the live box lacks (`memory_feedback`, `tool_authz_log`). So a live dump would bake in a Frankenstein schema missing 4+ recent migrations + transient cruft (exactly what D-003 wanted to avoid). **Decision: the reference build (fresh scratch, ALL migrations applied) stays the base + oracle.** Its only gap (14 ghost tables) is closed per D-008. Verified by P-006's 0-diff gate.

### D-008 — The 14 ghost tables: 3 groups, closed two ways
2026-06-02. The 14 tables a pure migrations+ensures build misses break down as:
- **Group A (5): the 2nd migration system** `apps/operator/lib/commands/migrations/*.sql` (15 files, applied manually in prod, no runner): `agent_actions`, `agent_queries`, `el_conv_calls`, `voice_utterances`, and `delegates` (= `claude_sessions` renamed by `003`). → reference build now **applies these `*.sql`** (carries the rename; ensure-schema still makes the stale `claude_sessions` name, a real drift the squash fixes).
- **Group B (4): inline TS runtime DDL** — `voice_lease`, `operator_claims`, `harness_prompt_overrides`, `git_export_outbox` (scattered `CREATE TABLE` in feature modules; Phase-2 delete targets).
- **Group C (5): true orphans** — `harness_experts`, `harness_skills`, `orchestrator_settings`, `agent_chats_consolidated`, `feature_audit_consolidated`: no active creator in ANY build path; DDL exists only in Drizzle's `0000_many_james_howlett.sql`/`generated.reference.sql`. All still referenced in live code → KEEP.
- Groups B+C captured to `apps/operator/lib/db-tools/baseline-extra-tables.sql` (DDL pg_dump'd from live; not migration-managed so the box's missing 098-106 don't affect them). Both the fragment + generator are transient (deleted in Phase 2); the durable artifact is `000-baseline.sql`.

### D-009 — Defer the squash's irreversible step? NO — user authorized full completion
2026-06-02. Initial recommendation was to do churn-safe prep now + hold Phases 1-2 until the 097-106 churn settled. User then put the session on a loop with explicit authority to complete + test the WHOLE plan. Proceeding through all phases, gated on the green P-006 diff, with per-step verification (tsc/tests/boot) and per-turn commits. Squash locks `sql/`; new migrations stay 107+.
