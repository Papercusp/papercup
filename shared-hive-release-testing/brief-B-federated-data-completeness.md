# Brief B — Federated-data completeness matrix

**Priority: S0 lane.** Mostly integration tests; no live instances needed (can run
fully in parallel with everyone).

## Objective
Prove that **every table that captures to the substrate outbox also fully applies
on a peer** — capture → outbox → swarm → merge → projection → peer-PG, with
`origin=remote`. Find every table that captures but silently drops on the apply
side (data loss on a real pot).

## Why it matters for release
Every table that should federate but silently doesn't = data loss on a real pot.

**CRITICAL distinction (verified — do not conflate these):** there are TWO trigger
families and only one is federation:
- `emit_change_notify_trg` (AFTER INS/UPD/DEL) = **LOCAL** SSE/UI change-notify.
  NOT federation. Tables with ONLY this are local-only by design.
- the **substrate-capture-outbox** trigger = **FEDERATION IN** (writes to
  `substrate_outbox`). THIS is what means "this table federates".

A first pass shows the genuinely federated set (substrate-capture) is smaller than
the raw trigger count and mostly DOES have a matching projection
(`harness_features_consolidated`, `harness_issues_consolidated`, `engineer_issues`,
`harness_plans`, `harness_plan_parts`, `plan_item_assignments`, `hive_members`,
`hive_settings`, `contributor_usage_events`, the `coord_*` family, `feature_queue`/
`working_set`/`claims`, `contributors`, `harness_registry`). So the matrix's real
job is two-fold:
1. **Prove** each federated table's apply path with a dedicated teeth-verified
   2-peer test (many lack one even though a projection exists).
2. **Classify + JUSTIFY each local-only table** (`emit_change_notify`-only):
   confirm local-only is INTENTIONAL, not an accidental missing-federation. The
   one to investigate hardest is **`trusted_authors`** — it is currently LOCAL-ONLY,
   but if a pot owner trusts/untrusts an author, should that decision federate to
   members (so admission/auto-pick is consistent pot-wide)? If yes, local-only is
   an S1 federation GAP. Same question for `claim_audit`/`auto_review_audit`
   (cross-peer audit visibility) and `harness_feature_prs`.

## Scope
1. **Build the matrix.** Enumerate capture-trigger tables from
   `libs/papercusp/libs/db/sql/*.sql` (the migration-102 family) and projections
   (`build*Projection` / `tableTag`) in `lib/sync/.../projections`. For each table:
   `{ captures? , has projection? , has federation test? , intended local-only? }`.
2. **Tables to scrutinize first** (capture but no obvious projection in scope):
   `trusted_authors` (SECURITY — must federate correctly or admission breaks),
   `agent_chats_consolidated`, `harness_feature_prs`, `pr_check_status_cache`,
   `pr_reviewer_settings`, `claim_audit`, `auto_review_audit`, `feature_claims`,
   `plan_item_claims`, `engineer_issues`, `harness_issues_consolidated`,
   `contributor_usage_events`, `webhook_audit`, `insights_first_visit`,
   `shared_repo_binding_cache`, `harness_registry`.
3. For every **federated** table with no dedicated 2-peer test, write one
   (reuse `_cross-peer-rig` / `composition-rig`): write on A → assert applied on B
   with correct columns + `origin=remote`; UPDATE federates; DELETE/tombstone
   federates (the row is removed on B).
4. **Column-completeness:** assert the projection carries EVERY column the writer
   set — the `requeue_count` bug (a column existed in prod but not the test
   schema) shows column drift is real. Build test schemas from the REAL baseline
   DDL + migrations, not hand-rolled subsets.

## Method
- Integration tests (`vitest.integration.config.ts`), testcontainer PG.
- For the classification, a generated coverage report (checked into
  `findings-B.md`) — table × {capture, project, test, decision}.

## Deliverables
- `findings-B.md`: the full matrix + a verdict per table (federated+tested /
  federated+UNTESTED-now-tested / intentionally-local-only-with-citation /
  **BUG: captures but never applies**).
- New 2-peer tests for every previously-untested federated table.

## Done / verdict
GREEN only when every capture table is classified, every federated one has a
green teeth-verified 2-peer test (insert+update+delete), and column-completeness
is asserted against the real DDL.
