# Brief B — Federated-data completeness findings

Owner: su-dd215. Lane: federated-data completeness matrix (capture → outbox → swarm
→ merge → projection → peer-PG, with `origin=remote`).

**Dimension verdict: GREEN with one YELLOW caveat (B-002, an owner decision).**
The substrate-outbox capture→apply path is structurally sound and far more complete
than the brief's first pass assumed: every federated table has a producer AND a
registered projection (both pinned by existing CI guards), and 12 of 13 CDC tables
already have real 2-peer crossing tests. The one genuine release risk is at the
**column grain**, not the table grain — and it was previously **unguarded**. This
pass closed it with a new teeth-verified guard and surfaced one owner decision.

---

## What "federates" actually means here (verified, not assumed)

Two trigger families exist; only one is federation (brief's CRITICAL distinction — confirmed):
- `emit_change_notify_trg` (mig 107 family) = **LOCAL** SSE/UI change-notify. Never
  writes `substrate_outbox`. Tables with ONLY this are local-only **by design**.
- `capture_substrate_outbox()` / `capture_<x>_outbox()` = **FEDERATION IN** (writes
  `substrate_outbox`). This is the capture side.

The full pipeline: local write → capture trigger → `substrate_outbox` → `outbox-drain.ts`
→ `outboxRowToLocalWriteOp` reshapes the row through a per-table **value mapper**
(`feature-issue-op-keys.ts`) → own Hypercore log → swarm → peer merge → projection
`writeToPg` → peer PG with `origin='remote'`.

**The federated set is exactly 18 tables** (`PEER_LOG_TABLES` in
`harness-state/table-registry.ts`): 13 CDC-captured (substrate-outbox triggers) +
5 log-first (direct `ownLog.append`). This is enforced — capture coverage and
projection coverage each have a green CI guard (see "Structural guarantees" below),
so the **table-grain** "captures but never applies" S0 class is structurally
prevented. The remaining risk is finer-grained (B-001/B-002).

---

## The capture → apply matrix

### CDC-captured federated tables (substrate-outbox → drain → projection)

| # | Table | tableTag | Capture (mig) | Dedicated 2-peer capture→apply test | Column-completeness |
|---|-------|----------|---------------|-------------------------------------|---------------------|
| 1 | `harness_features_consolidated` | `features-by-id` | 108/114 | `feature-content-federation` (real Hyperswarm, 2×PG, ins/upd/del, origin=remote) | **drops content-looking cols → B-002** |
| 2 | `harness_issues_consolidated` | `issues` | 108/114 | `feature-content-federation` | ✅ all content federates |
| 3 | `contributor_usage_events` | `usage` | 108 | `federation-edge-cases` G2 (A→B, byte-equal payload, echo guard) | ✅ |
| 4 | `harness_plans` | `plans-by-slug` | 125 | `cross-plan-federation-seam` (drain+trig+apply+remote) | ✅ (content+hash; structured cols re-derived from content) |
| 5 | `coord_conversations` | `coord-conversations` | 144 | `coord-conversation-federation` (2-peer convergence + LWW) | ✅ |
| 6 | `coord_event_log` | `coord-messages` | 150 | `coord-message-federation` (2-peer, scope-gated) | ✅ |
| 7 | `coord_threads` | `coord-threads` | 149 | `coord-thread-federation` (2-peer A↔B) | ✅ |
| 8 | `coord_thread_posts` | `coord-thread-posts` | 149 | `coord-thread-federation` | ✅ |
| 9 | `plan_item_assignments` | `item-assignments` | 140/145 | `plan-item-assignment-two-peer-federation` (FULL, bidir) | ✅ |
| 10 | `hive_settings` | `hive-settings-by-key` | 186 | `cross-hive-grant-federation` G25/G26 (2-peer, LWW converge) | ✅ |
| 11 | `hive_members` | `hive-members` | 189 | `hive-members-federation-trigger` + `…teardown…` (2-peer + tombstone) | ✅ |
| 12 | `engineer_issues` | `engineer-issues` | 197 | `engineer-issues-federation-trigger` (2-peer, scope-derived slug) | ✅ |
| 13 | `harness_plan_parts` | `plan-parts` | 271 (flag-gated) | `plan-part-federation-cutover` (partial) | ✅ mapper; **federation DARK until `papercusp-plan-part-federation`** |

### Log-first federated tables (direct `ownLog.append`, no substrate-outbox)

| # | Table | tableTag | Producer | 2-peer capture→apply test |
|---|-------|----------|----------|----------------------------|
| 14 | `feature_claims` | `claims` | `orchestrator/feature-claim.ts` | projection-unit only → **B-003** |
| 15 | `feature_queue` | `queue` | `write-feature-queue.ts` | projection-unit only → **B-003** |
| 16 | `feature_working_set` | `working-set` | `write-working-set.ts` | projection-unit + `delete-lww-guard` → **B-003** |
| 17 | `contributors` | `contributors` | `write-contributor-row.ts` | projection-unit only → **B-003** |
| 18 | `shared_presence` | `presence` | `presence-announce.ts` | ✅ exercised 2-peer by `_cross-peer-rig` (the roster the rigs federate) |

### Scrutinized local-only tables — classified + justified

| Table | Classification | Verdict |
|-------|----------------|---------|
| `trusted_authors` | SECURITY (sync:'none', security-forced) | ✅ **intentional + correct** — see B-005 (federating it would be S0) |
| `claim_audit`, `auto_review_audit`, `webhook_audit` | DEFAULT/SECURITY, change-notify only | ✅ intentional-local; cross-peer audit visibility is a future S2 enhancement, not a release gap |
| `harness_feature_prs` | retired (EI-479) → sync:'none' | ✅ correct — PR state is GitHub-derived + re-polled per machine; federation redundant |
| `pr_check_status_cache`, `pr_reviewer_settings` | cache / workspace-owned settings | ✅ local by design |
| `insights_first_visit`, `known_schema_versions` | workspace-owned config | ✅ local |
| `harness_registry` | **workspace-owned / sync:'none'** | ✅ local — **the brief's first pass listed this as federated; it is NOT** (it's the per-workspace harness-membership JSONB). Correction noted. |
| `agent_chats_consolidated`, `shared_repo_binding_cache` | DEFAULT (slug-shared/none) | ✅ local by design |

---

## Findings

### B-001 — Column-completeness was UNGUARDED; the silent-column-drop data-loss class (S1, now closed by a guard)

**Severity:** S1 (a federated table column added by a future migration without a
mapper update silently drops on every peer — data loss). Class severity; the
*specific* live instances are B-002.

**Claim:** The two existing coverage guards prove federation at the **table** grain
only. The CDC apply path reshapes each row through a hand-written value mapper
(`feature-issue-op-keys.ts`); the projection then INSERTs only the keys that mapper
carries. **Nothing asserted that the mapper carries every column the writer set.** A
column added to a federated table whose mapper isn't updated federates the *row* but
lands that column NULL/default on the peer — silently. This is the generalized
`requeue_count` class (README §"Why a new pass" bug #4 — a column that existed in
prod but not the federation/test path), and it is the brief's S0/S1 concern at the
column grain.

**Why the green suite missed it:** the flagship `feature-content-federation` test
stands up a **hand-rolled subset** test schema (a `CREATE TABLE` with only the
columns it enumerates) and asserts via `toMatchObject` (which ignores absent keys).
It structurally cannot see a column it didn't list — exactly the anti-pattern the
brief warns against ("Build test schemas from the REAL DDL + migrations, not
hand-rolled subsets").

**Fix shipped (teeth-verified):**
`packages/operator-core/lib/sync/hyperbee/__tests__/federated-column-completeness.integration.test.ts`.
It migrates an empty DB `000-baseline → head` through the **real** boot-path runner
(`applyPendingMigrations`), introspects `information_schema.columns` for each of the
13 CDC tables, runs the **real** `outboxRowToLocalWriteOp` over a synthetic
full-column row, and asserts every real column is either (a) carried by the mapper,
(b) PROVENANCE (set by the projection from the op envelope — `workspace_id`/`origin`/
`fed_ts`/`author_pubkey`/…), (c) a generated/tsvector/identity-pk column PG computes
locally (auto-detected), or (d) explicitly in `NOT_FEDERATED[table]` with a one-line
reason. Any column outside all four FAILS, naming it + the remediation. A future
migration column that nobody maps now trips CI automatically.
- Teeth: removing `severity` from `toIssueValue` → guard goes RED ("Dropped: severity");
  restored byte-identical → GREEN (14/14).

### B-002 — `harness_features_consolidated` silently drops content-looking columns on federation (S1/S2, owner decision)

**Severity:** S1 if any is true content that must federate; S2 if all are
acceptably local. **Owner call required.**

**Claim:** Unlike issues (which federate every content column) and every other
federated table, the **feature** mapper (`toFeatureValue`) carries ~27 of ~45
columns. After excluding legitimately-local columns (verifier state, `_search`,
`working_users` derived from `feature_working_set`, per-bee `*_rank` ordering,
scheduling `schedule*`/`tzid`/`template_slug`/`run_seq`, `requeue_count` retry
counter, provenance), the following **content-looking** columns are currently
**silently not federated** — a feature created on peer A lands on peer B with each
NULL:

- `design_spec_id`, `design_status`, `needs_design`, `discarded_design_work` — the feature's design linkage/state.
- `source_plan_slug`, `source_plan_item_ids` — the plan→feature lineage (**plans DO federate**, so the link is lost on B).
- `see_also` — cross-feature references.
- `wave` — promote-wave dispatch metadata (its sibling `feature_order` IS federated — likely an oversight).
- `deprecation_reason` — `status` federates but the reason for it does not.
- `completion_ref` — completion-artifact pointer.

The mapper was authored early (Stage-2 feature-content-federation) and the column
set grew without it; the asymmetry vs every other table is the tell. These are
allow-listed in the new guard under `REVIEW(findings-B)` tags so CI stays green, but
each is an explicit federate-or-keep-local decision that no one has made. The
verifier/audit columns (`audit_verdict`/`audited_at`/`verifier_*`) are plausibly
intentional-local (each peer re-audits) but should be confirmed in the same pass.

**Recommendation:** owner adjudicates per column. For each that should federate: add
it to `toFeatureValue` + the `harness-features` projection INSERT/UPSERT + the
`feature-content-federation` real-schema assertion, then drop its `REVIEW` tag. For
each confirmed-local: keep the allow-list entry, drop the `REVIEW` tag. Not a
crash/corruption blocker, so it does not by itself hold release — but "a federated
feature loses its design + plan lineage on a real hive" should be a conscious choice
before public release, not a silent gap.

### B-003 — Log-first federated tables lacked a real 2-peer crossing test (S2 — NOW FULLY CLOSED this pass)

**Severity:** S2 (the projection write/delete paths ARE unit-tested against real PG;
what was untested is the end-to-end `ownLog.append` → swarm → peer-apply crossing).

The 4 substrate-free log-first tables federate via direct `ownLog.append` and had
only **single-PG projection-unit tests** — no test wrote on peer A and asserted the
row applied on peer B. (`shared_presence`, the 5th log-first table, IS exercised
2-peer — it is the roster `_cross-peer-rig` federates. The composition-rig loop tests
exercise the loop with a *fake* pipeline, not these tables' real apply.)

**Two closed this pass (the highest-value ones):**
- `feature-claims-two-peer-federation.integration.test.ts` (the highest-STAKES) — two
  mutually-admitted Swarms on a real loopback DHT, each wiring the REAL `feature_claims`
  projection; each peer appends a claim exactly as `orchestrator/feature-claim.ts` does,
  and the test asserts each peer's PG ends holding the OTHER peer's claim (the property
  that lets the orchestrator on B see A's claim → a double-claim is detectable instead of
  both peers working a feature blind). Column-completeness at the crossing + no echo
  mis-attribution. Teeth: no-op the projection `writeToPg` → RED; restore → GREEN.
- `contributors-two-peer-federation.integration.test.ts` (admission-relevant + the only
  one with a DELETE path) — the per-harness contributor/device roster. Proves (1) the row
  crosses A→B with the `device_attestations` JSONB array + `binding_status` +
  `revoked_pubkeys` intact (jsonb not silently flattened), and (2) a contributor TOMBSTONE
  (`del`, EI-79 ts-guarded) crosses A→B and removes the row on B (a removed contributor
  doesn't linger on the peer). Teeth: no-op the projection `deleteFromPg` → the tombstone
  proof goes RED; restore → GREEN.

To build them I added a small **additive, backward-compatible seam** to `_cross-peer-rig.ts`
(`buildPeerApply`/`bootPresencePeer`/`federateTwoPeerPresence` now take optional
`extraProjections`), verified safe by re-running the rig's existing consumers
(`cross-peer-coordination` 9/9 + `leave-hive-tombstone` 1/1).

**`feature_queue` + `feature_working_set` closed (the last two):**
`feature-queue-workingset-two-peer-federation.integration.test.ts` — one real two-peer
rig wiring BOTH projections; proves each work-pointer crosses A→B as a `put` and is
removed on B by a `del` tombstone (ts-guarded). The `feature_working_set` apply's
`working_users[]` recompute (`UPDATE harness_features_consolidated`) is exercised on the
peer too (a minimal real-shape features table is present). Teeth: no-op the queue
`writeToPg` → RED ("never crossed A→B"); restore → GREEN.

**Status: B-003 is fully closed.** All 5 log-first federated tables now have a real
2-peer crossing test — `shared_presence` (pre-existing via `_cross-peer-rig`),
`feature_claims`, `contributors`, `feature_queue`, `feature_working_set` (this pass).

### B-004 — Brief first-pass corrections (informational)

- `harness_registry` is **workspace-owned / sync:'none'**, NOT federated (brief's
  first pass listed it among the federated set). It's the per-workspace harness
  membership list.
- `harness_feature_prs` is **retired** (EI-479): the orphan `prs` projection was
  removed and the table reclassified `sync:'none'`. No producer ever existed. Not a gap.
- `agent_chats_consolidated`, `shared_repo_binding_cache` resolve to DEFAULT
  (slug-shared/none) — local by design.

### B-005 — `trusted_authors` local-only is INTENTIONAL and CORRECT (not a gap)

The brief flagged this as the hardest question: should an owner's trust/untrust
decision federate so admission is hive-consistent? **No — federating it would be an
S0 security hole.** `trusted_authors` is the owner's LOCAL grant that a verified
author's remote work may **auto-run (execute code)** on the owner's install bypassing
per-item screening (`trust:add` is documented "owner-scoped, local-only, never
federated"). Federating it would let one member's trust decision grant code execution
on another member's machine — supply-chain/privilege escalation. Crucially, the
**admission-consistency** the brief worried about is already handled by a *different,
federated* table: `hive_members` (carries `device_attestations` + `revoked_pubkeys` +
`binding_status`) DOES federate, so cryptographic membership and **revocation** are
hive-consistent. Trust (the auto-run privilege) is a deliberately separate, per-owner
layer **on top of** federated admission. Correct separation; no change recommended.

---

## Structural guarantees this pass verified (the floor under the verdict)

- **Capture coverage** (`__tests__/capture-coverage.test.ts`, `checkSubstrateCaptureCoverage`)
  — every `sync:'peer-log'` table has exactly one producer (CDC trigger / log-first
  append / documented accepted-unfederated). GREEN. → no table captures with no producer.
- **Projection coverage** (`harness-state/projection-engine.test.ts`, `checkPeerLogConsistency`)
  — every federated tableTag has a registered projection. GREEN. → no table federates
  with no apply path.
- 18 registered projection tags ↔ 18 federated tables ↔ 13 CDC + 5 log-first producers
  reconcile exactly. Together these prevent the **table-grain** "captures but never
  applies" S0 class by construction; B-001's new guard extends the floor to the
  **column** grain.

## Known blind spot (from README) — status

The brief warns the rigs wire both peers onto matching topics directly, bypassing
`defaultResolveSwarmBinding` (the real joiner-resolves-its-own-topic path). This pass
did NOT close that — it is a topic-derivation concern (Brief A's live path + the
`derive-swarm-topic` unit tests), orthogonal to the data-completeness matrix here.
My column-drift guard runs over the mapper directly, so it is unaffected by the topic
path. Flagged so it is not assumed covered.

## What I tested (new, teeth-verified)

- `federated-column-completeness.integration.test.ts` (B-001) — 13 CDC tables ×
  real migrated schema; the column-drift guard. Teeth-verified (drop `severity` from
  `toIssueValue` → RED; restore → GREEN). 14/14 green.
- `feature-claims-two-peer-federation.integration.test.ts` (B-003) — real 2-peer
  swarm crossing for `feature_claims`. Teeth-verified (no-op the projection → RED;
  restore → GREEN). 1/1 green.
- `contributors-two-peer-federation.integration.test.ts` (B-003) — real 2-peer swarm
  crossing for `contributors`: row crossing (jsonb attestations intact) + tombstone
  crossing (ts-guarded del removes the row on B). Teeth-verified (no-op `deleteFromPg`
  → tombstone proof RED; restore → GREEN). 1/1 green.
- `feature-queue-workingset-two-peer-federation.integration.test.ts` (B-003) — real
  2-peer crossing for `feature_queue` + `feature_working_set` (put + del tombstone each;
  the working_users recompute runs on the peer). Teeth-verified (no-op the queue
  `writeToPg` → RED; restore → GREEN). 1/1 green. **→ B-003 fully closed.**
- Additive seam on `_cross-peer-rig.ts` (`extraProjections`) — backward-compatible;
  verified by re-running its consumers (`cross-peer-coordination` 9/9,
  `leave-hive-tombstone` 1/1).
- Re-ran + confirmed green: the two structural guards `capture-coverage.test.ts` +
  `projection-engine.test.ts` (18/18).
- No production source semantics changed: `feature-issue-op-keys.ts` and
  `projections/feature-claims.ts` are byte-identical to HEAD after teeth-verification;
  the only non-test edit is the additive rig seam.

## Verdict

**GREEN** for the substrate-outbox capture→apply path: structurally guarded at the
table grain (two green coverage guards) and now the **column grain** (new B-001
guard); 12/13 CDC tables have real 2-peer tests (`harness_plan_parts` is DARK-by-flag,
not broken); and the highest-stakes log-first table (`feature_claims`) now has a real
teeth-verified 2-peer crossing test. **YELLOW pending the B-002 owner decision** — a
federated feature currently loses its design + plan-lineage + a few content columns on
a peer; that should be a conscious choice before public release (filed as WI-251).
**B-003 is now fully closed** — all 5 log-first federated tables have a real
teeth-verified 2-peer crossing test. **No S0 data-loss/corruption found in the
federated path.** The only residual is the B-002 owner decision (the YELLOW above).
