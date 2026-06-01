---
title: Feature-content + issue federation (PG→Hyperbee write-side, task #14)
status: done
created: 2026-06-01
---

# Feature-content + issue federation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make local **feature content** (`harness_features`) and **issues** (`harness_issues`) federate over the Model B substrate — today only queue-membership / working-set / claims / contributor-rows reach the per-peer Hypercore log, so two federated peers never exchange the actual features or issues (and the auditor gate G1–G4, built to screen *remote* features, currently has nothing to screen).

**Architecture:** A **transactional-outbox CDC** seam. The consolidation triggers already funnel every feature/issue write into `harness_features_consolidated` / `harness_issues_consolidated`. We add an `AFTER` trigger that enqueues **local-origin** changes (using the G1 `origin` column to exclude the read-side projection's own writes — the echo-loop guard) into a `harness_shared.substrate_outbox` table + `NOTIFY`. A per-harness in-process drain task (`LISTEN` + poll fallback) reads undrained outbox rows and calls the existing `BootedHarnessHandle.append(LocalWriteOp)`, which appends to the own log → the existing `harness-features` / `issues` read-side projections apply it on peers. A one-time **backfill** enqueues all existing local rows on first boot after this ships.

**Tech Stack:** TypeScript (tsx host), Postgres (`getOrgPg()`, LISTEN/NOTIFY), Hypercore/Corestore (existing `peer-log.ts` / `boot.ts`), Vitest 4 (+ testcontainer PG for integration), the existing `write-feature-queue.ts` pattern.

---

## Why CDC-outbox, not dual-write (design decision D-1)

The Explore topology map found feature/issue writes scattered across **~25 independent SQL sites**: Hono routes (`features.ts` ×11, `snapshots.ts`, `promote.ts`, `brainstorm.ts`, `archives.ts`, `scoper-actions.ts`, `reviews.ts`), operator libs (`completion-ref-*.ts`, `execute-action.ts`, `promote-issue.ts`, `harness-issues.ts`), and the **submodule** orchestrator (`state-pg.ts:298-312`, `auditor-dispatch.ts:186/197`). No single code choke point exists.

- **Dual-write at each site** (mirror `write-feature-queue.ts`): rejected. 25 sites, ~6 in the `libs/papercusp` submodule → submodule churn, and every future write site must remember to dual-write — silent partial federation is the *exact* bug class we're fixing.
- **CDC-outbox via the consolidation trigger** (chosen): one trigger + one drain task captures **all** sites, including submodule writes, with **zero** changes to the 25 sites. Transactional (outbox row written in the same txn as the feature write → no lost writes). Resilient to "substrate not booted yet" (outbox persists; drain catches up).

This is change-data-capture *within one process* (canonical PG → the federation log), **not** using PG as a cross-app message bus — we use `LISTEN/NOTIFY` (event-driven, not polling) with a bounded poll only as a liveness fallback, consistent with the repo's "DB is not a transport" rule.

### The echo-loop hazard (D-2 — the one thing that must be right)
The read-side projections (`projections/harness-features.ts:107`, `issues.ts:88`) ALSO write `*_consolidated` — when applying a **remote** peer's op. If the CDC trigger captured those, a remote op would be re-appended to the local log and federated back → infinite amplification. **Guard:** the projection writers stamp `origin='remote'` (G1); local writes are `origin='local'` (or NULL pre-G1). The trigger enqueues **only** `NEW.origin='local' OR NEW.origin IS NULL`. Stage 0 de-risks this by proving the two write classes are reliably distinguishable.

---

## File Structure

- **Create** `libs/papercusp/libs/db/sql/099-substrate-outbox.sql` — the `harness_shared.substrate_outbox` table + the AFTER triggers on both consolidated tables + the NOTIFY function. (Also add the columns to the runtime `ensure-schema-dogfood.ts` CREATE bodies — fresh-boot parity, the G1 lesson.)
- **Create** `apps/operator/lib/sync/hyperbee/outbox-drain.ts` — `drainOutboxOnce(handle, pg)` (pure-ish: read undrained rows for this harness → `handle.append` → mark drained) + `startOutboxDrain(handle, pg)` (LISTEN + poll-fallback loop; returns a stopper).
- **Create** `apps/operator/lib/sync/hyperbee/backfill-local-state.ts` — `backfillLocalState(handle, pg)` — one-time enqueue of existing local `*_consolidated` rows into the outbox (idempotent via a per-harness marker row).
- **Create** `apps/operator/lib/sync/hyperbee/feature-issue-op-keys.ts` — `composeFeatureKey(featureId)` / `composeIssueKey(issueId)` + the row→`LocalWriteOp` mappers (`featureRowToOp`, `issueRowToOp`), mirroring `projections/harness-features.ts` + `issues.ts` row shapes so a `put` op projects cleanly.
- **Modify** `apps/operator/lib/sync/hyperbee/boot-all.ts` (~line 200, post-boot) — after each harness boots: `await backfillLocalState(handle, pg)` (once) then `startOutboxDrain(handle, pg)`; track the stopper for `close()`.
- **Modify** `apps/operator/lib/sync/hyperbee/boot.ts` — add the drain-stopper to `close()` teardown.
- **Test** colocated `*.test.ts` per module + one integration test `apps/operator/test/feature-content-federation.integration.test.ts`.

---

## Stage 0 — De-risk the echo-loop guard (no production code)

- [ ] **Step 1: Confirm `origin` reliably separates local writes from projection writes.** Read `projections/harness-features.ts` + `issues.ts` and confirm every projection INSERT/UPDATE sets `origin='remote'` (G1). Read the 25 local write sites' columns and confirm none set `origin='remote'` (they set `'local'` or leave it to the default). Read migration 097 (`origin TEXT NOT NULL DEFAULT 'local'`). Write a throwaway note: list any local write site that does NOT result in `origin IN ('local', NULL)`, and any projection write that does NOT set `origin='remote'`.
- [ ] **Step 2: Decision gate.** If any local site lands `origin='remote'` or any projection write lands `origin='local'`, STOP and revise the guard (e.g. add a session GUC `papercusp.applying_remote=on` set by the projection, and gate the trigger on that instead). Record the chosen guard. Expected: the `origin` filter is sufficient.

## Stage 1 — Outbox table + capture triggers

- [ ] **Step 1: Write the failing test** `outbox-trigger.integration.test.ts` (testcontainer PG): create the consolidated tables + the migration, INSERT a local feature (`origin='local'`) → assert one `substrate_outbox` row with `{table:'harness_features', op:'put', key:<feature_id>, row jsonb}`; INSERT a remote feature (`origin='remote'`) → assert **no** outbox row; DELETE a local feature → assert an `op:'del'` outbox row.
- [ ] **Step 2: Run → FAIL** (no migration yet).
- [ ] **Step 3: Write `099-substrate-outbox.sql`** — `substrate_outbox(id bigserial pk, workspace_id text, harness_slug text, table_name text, op text, key text, row jsonb, ts bigint, drained_at bigint null)`; an `AFTER INSERT OR UPDATE OR DELETE` trigger fn on each consolidated table that, when `COALESCE(NEW.origin,'local')='local'` (or on DELETE, `OLD.origin`), inserts an outbox row + `PERFORM pg_notify('substrate_outbox', workspace_id||'::'||harness_slug)`. Mirror the columns into `ensure-schema-dogfood.ts`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(substrate): outbox + local-origin capture triggers for feature/issue federation`.

## Stage 2 — Op-key + row→op mappers

- [ ] **Step 1: Failing test** `feature-issue-op-keys.test.ts`: `featureRowToOp(row)` returns a `LocalWriteOp` whose `value` matches the `HarnessFeatureRow` shape the projection expects (assert field-for-field against `projections/harness-features.ts` `HarnessFeatureRow`); same for `issueRowToOp`. `composeFeatureKey('F-001')`/`composeIssueKey('I-001')` deterministic.
- [ ] **Step 2: FAIL → Step 3: implement** `feature-issue-op-keys.ts` using `CURRENT_SCHEMA_VERSION` + the exact projection row shapes. **Step 4: PASS. Step 5: Commit.**

## Stage 3 — Outbox drain loop

- [ ] **Step 1: Failing test** `outbox-drain.test.ts`: a fake `BootedHarnessHandle` (capture `append` calls) + an in-memory/testcontainer outbox seeded with 3 undrained rows (2 feature put, 1 issue del) → `drainOutboxOnce(handle, pg)` calls `handle.append` 3× with the mapped ops in `id` order, marks all 3 `drained_at`; a second `drainOutboxOnce` is a no-op (idempotent). Handle-append throwing on row 2 leaves rows 2,3 undrained (at-least-once, no data loss).
- [ ] **Step 2: FAIL → Step 3: implement** `outbox-drain.ts`: `drainOutboxOnce` (SELECT undrained WHERE harness_slug/ workspace ORDER BY id LIMIT N → map → append → UPDATE drained_at) and `startOutboxDrain` (a `LISTEN substrate_outbox` connection that calls drain on a matching notify, plus a 5s poll fallback; returns `stop()`). **Step 4: PASS. Step 5: Commit.**

## Stage 4 — Backfill existing local state

- [ ] **Step 1: Failing test** `backfill-local-state.test.ts`: seed `*_consolidated` with 4 local features + 2 issues (and 1 `origin='remote'` feature) directly (bypassing the trigger, e.g. `origin` preset) → `backfillLocalState(handle, pg)` enqueues exactly the 4+2 local rows to the outbox (not the remote one), writes a `substrate_backfill_done` marker; a second call is a no-op (marker present). Respects an `opts.maxRows` cap aligned with the Stage-6 per-author ingest cap (log a `peer_capped`-style warning if exceeded).
- [ ] **Step 2: FAIL → Step 3: implement** `backfill-local-state.ts` (idempotent marker row in `substrate_outbox` or a small `substrate_meta` table). **Step 4: PASS. Step 5: Commit.**

## Stage 5 — Wire into boot + close

- [ ] **Step 1:** In `boot-all.ts` post-boot (~line 200), after `getBootedHarness` is live: `await backfillLocalState(handle, pg)` then `const stop = startOutboxDrain(handle, pg)`; store `stop` for teardown. In `boot.ts` `close()`, call `stop()`.
- [ ] **Step 2:** Run the existing hyperbee boot/boot-all tests → green (no regression). **Step 3: Commit.**

## Stage 6 — End-to-end federation integration test (the acceptance) — DONE

- [x] **Step 1:** `apps/operator/lib/sync/hyperbee/__tests__/feature-content-federation.integration.test.ts` — two substrate instances on one box over the real in-process swarm (mirrors `two-peer-swarm-bidi.test.ts`'s harness, real `verifyAnnounce`, channel-2 gate stood in for by `verifyBindingOverride`). Each peer has its OWN throwaway Postgres database (`createFreshPgDb`); the features/issues projections are bound to that peer's `sql` via a new `HarnessFeaturesProjectionOpts.sql` / `IssuesProjectionOpts.sql` seam, so A writes only to A's DB and B's projection writes only to B's DB (asserted: distinct `current_database()`). Peer A: INSERT a local feature into A's consolidated → real migration-102 trigger → outbox → `drainOutboxOnce` → A's log → real swarm replication → B admits A → B's read-merge → B's REAL projection writes it into B's `harness_features_consolidated`. Asserts the actual row (title/status/origin='remote'/workspace_id) lands in B. Symmetric B→A. Issue A→B too (exercises the migration-103 workspace_id fill — asserted the issue row's workspace_id is the real value, not ''). Echo-loop guards: (3a) B does NOT re-enqueue A's received `origin='remote'` rows; (3b) a direct `origin='remote'` insert on A enqueues nothing; (3c) the outbox reaches a FIXED POINT under repeated merge+drain (no unbounded intra-peer self-amplification).
- [x] **Step 1a (send-side fix surfaced by the test):** the read-merge re-applies the OWN log every pass, re-UPSERTing local rows with identical values → without a guard the capture trigger re-enqueued them forever (verified 1→2 growth). Fixed migration 102: split the capture trigger into `AFTER INSERT OR DELETE` (unconditional) + `AFTER UPDATE … WHEN (OLD.* IS DISTINCT FROM NEW.*)`, so a no-op self-merge-back re-upsert does not enqueue. (libs/papercusp submodule.)
- [x] **Step 2: Run → PASS** (testcontainer PG, Docker up; 429 hyperbee/projection tests green, no regression). Anti-tautology verified: disabling `drainOutboxOnce` makes the A→B acceptance fail (`F-fed-1` never reaches B's PG), confirming the test depends on the real outbox send-side and the two peers use genuinely separate databases.
- [x] **Step 3:** Updated `agent-insights/phase1b-federation-limitations.mdx` with a "Resolved — feature content + issues now federate (CDC-outbox)" section + the echo-guard note. (Docs rebuild deferred — prose-only edit.)
- [x] **Step 4: Commit.**

## Decisions
- **D-1** CDC-outbox over dual-write — scatter (25 sites) + submodule split makes dual-write fragile; trigger-capture is complete + zero-touch.
- **D-2** Echo-loop guard = `origin='local'` filter in the capture trigger (Stage 0 confirms sufficiency).
- **D-3** LISTEN/NOTIFY (event-driven) + bounded poll fallback — not polling-as-transport; CDC within one process.
- **D-4** At-least-once delivery (drain marks `drained_at` after append) — LWW merge + idempotent projection (`INSERT…ON CONFLICT`) tolerate duplicate/reordered ops, so at-least-once is safe.

## Open questions for the reviewer
1. **Outbox retention** — delete drained rows immediately, or keep + GC after N days for audit? (Plan assumes mark-drained + a later GC; cheap to change.)
2. **Per-author cap interaction** — a large existing harness backfilled at once could approach the Stage-6 `maxOpsPerAuthor`. Acceptable to cap + warn, or should backfill chunk over time?
3. **`completion-ref` / `auditor-dispatch` consolidated writes** — these are legitimate local writes that SHOULD federate (e.g. a completion ref). Confirm we *want* them captured (the `origin='local'` filter will capture them). I believe yes.
