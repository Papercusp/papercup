# DRAIN duplicate and physical-twin dry-run manifest

Generated: **2026-08-13T07:15:20-04:00**  
Tracking: **WI-38444 / `drain-admission-integrity-remediation-2026-08-13#P-004`**  
Decision: **D-001 — snapshot first; preserve evidence and structured links; never fuzzy-bulk-delete**  
Scope: issue-family rows (`bug`, `change`, `task`) in `papercusp-workspace`, with logical cleanup focused on nonterminal Papercusp bugs.

> This is a mutation-free manifest. It does not terminal a work-item, add or remove a link, update a base row, or select a physical-row survivor. All proposed actions are for P-005 and remain conditional on its reference audit.

## Restore anchor

| Field | Value |
|---|---|
| Backup ledger row | `74209` |
| Kopia snapshot | `ee8d1d2dacd7b4522d3155fba6a1019d` |
| Status | `ok` |
| Started | `2026-08-13T11:06:34.857Z` |
| Finished | `2026-08-13T11:09:02.743Z` |
| Reason | `pre_destructive` |
| Note | `WI-38444 / P-004 baseline before evidence-preserving DRAIN duplicate/twin cleanup; manifest phase remains no-mutation.` |

Do not use backup row `74208` as the restore anchor. The single caller invocation produced two identical backup rows; `74208` later finished `degraded` because its pre-snapshot Postgres dump did not land. The healthy row above is the valid pre-destructive anchor. The timeout and duplicated invocation are tracked as `EI-20335705610176657` and `EI-20335752357525707`.

## Writer semantics used by this manifest

- Logical identity is the server writer's `admissionIdentity.titleKey`: `title:` plus `dedupSignature(title)`, where the writer strips a leading kind, lowercases, removes punctuation, drops tokens of length 2 or less, de-duplicates tokens, and sorts them. Legacy rows without persisted identity are classified by recomputing this exact function in SQL.
- Strong source identity is `admissionIdentity.signalKey`, with legacy `payload.watchdogKey` and `condition_key` accepted only as compatibility fallbacks.
- Terminal means the exact transitional set used by `SETTLED_WORK_ITEM_STATES`: `passed`, `deprecated`, `resolved`, `closed`, `done`, or `dropped`.
- Claimable stock comes from `work_items:claimable`, the same caller-aware oracle used by `scheduler:get_next`; raw `open` counts are not substituted for it.
- A physical twin candidate is more than one base-table row for the same `(workspace_id, feature_id)` in the issue family. Content-identical candidates and divergent ID collisions are kept separate.

## Baseline

At measurement time, the caller-aware oracle reported **1,722 claimable Papercusp bugs**: 4 critical, 109 major, 1,441 minor, and 168 nit. Minor + nit were **93.4%** of the lane; the peak admission day was 2026-08-12 with 1,073 rows. These numbers describe the oracle at measurement time, not the immutable snapshot contents.

## Class A — exact logical duplicates

One nonterminal cluster has the same raw title and therefore the same normalized `titleKey`:

| Proposed survivor | Proposed duplicate | Evidence | P-005 dry-run action |
|---|---|---|---|
| `EI-20242769536779656` | `EI-20242769786860848` | Identical title, identical normalized key `title:before complete get json payload plans ptool reply truncated`, both minor/open, created 249 ms apart | Preserve the earlier row; add `duplicates` from the later row to the survivor; terminal only the later row with structured completion evidence. |

Both rows predate persisted admission identity and dedup-coverage fields. Their missing fields are evidence about admission history, not a reason to erase either record.

## Class B — probable same-root findings

One nonterminal pair carries the same stable tool-failure signal while using different titles:

| Proposed survivor | Proposed same-root duplicate | Stable signal | Evidence | P-005 dry-run action |
|---|---|---|---|---|
| `EI-20334569848645340` | `EI-20335562969900283` | `repeated-tool-error:sessions:read:structural:structured-content-does-not-match-output` | Older row is major and carries the legacy `watchdogKey`; later minor row persists `admissionIdentity` and healthy lexical+semantic coverage. Both describe `sessions:read` emitting a turn that violates its own output schema. | Preserve the older major row as canonical evidence; copy/retain the later row's admission metadata in completion evidence; add `duplicates` (or `relates` only if P-005 finds materially distinct reproduction evidence); terminal the later row only after that check. |

No other nonterminal Papercusp bug group shared an exact normalized title or a non-empty stable signal key at measurement time.

## Class C — confirmed logical duplicates already carrying structured links

The following **17 nonterminal source rows** already have a `coord_links.rel='duplicates'` edge. P-005 may terminal the source row without inventing a relationship, but must retain the edge and the source evidence. A terminal or needs-human target is still the canonical history; it is not a license to choose a different target silently.

| Source to disposition | Existing canonical target |
|---|---|
| `WI-38366` | `EI-19408377748635848` |
| `WI-38350` | `WI-38348` |
| `EI-20228862518093529` | `EI-20184956238147732` |
| `EI-20227743809607118` | `EI-20184956238147732` |
| `EI-20225738754282862` | `EI-20184956238147732` |
| `EI-20207911926619210` | `EI-20184956238147732` |
| `EI-20216176753647821` | `EI-20212410498125081` |
| `EI-20206392451210997` | `EI-20008972146069883` |
| `WI-6335` | `WI-6936` |
| `EI-18664933641195210` | `WI-6936` |
| `EI-18734910825871393` | `EI-18733935898107794` |
| `WI-5666` | `WI-5667` |
| `WI-6143` | `EI-18734807835514559` |
| `EI-18712383368117845` | `WI-6043` |
| `EI-18662963598796485` | `papercusp#WI-5779` |
| `EI-18656161555358565` | `WI-5781` |
| `WI-4131` | `WI-5441` |

P-005 must use single-item `work_items:complete` calls with `completion.duplicateOf`; it must not rely on a batch-level terminal state because the batch form's top-level `state` is not authoritative.

## Class D — distinct lookalikes and divergent ID collisions

There are **11 logical IDs** with multiple physical rows whose title or body differs. These are **not physical-twin deletion candidates**. The shared ID is the collision; the work itself is divergent. Preserve all rows until P-005 can assign globally unique IDs and repoint references.

| Colliding ID | Physical scopes | Why it is distinct / unsafe to collapse |
|---|---|---|
| `EI-11513` | `papercusp`, `quartermaster-hive` | Papercusp auto-eligibility backlog vs Quartermaster escalation. |
| `EI-13306` | `operator:papercusp-workspace`, `papercusp` | Replication-liveness report vs claim-spec NULL/three-valued-logic defect. |
| `EI-14603` | `operator:papercusp-workspace`, `papercusp` | Replication-liveness report vs uncommitted-tree/git-sync notice. |
| `EI-16821` | `papercusp`, `papercusp-public-site-pot` | Replication-liveness report vs wake-injection hypothesis. |
| `EI-16843` | `papercusp`, `papercusp-public-site-pot` | Replication-liveness report vs work-item requeue/reopen guidance. |
| `EI-16844` | `papercusp`, `papercusp-public-site-pot` | Replication-liveness report vs directed-inbox coordination rule. |
| `EI-16855` | `papercusp`, `papercusp-public-site-pot` | Replication-liveness report vs directed-inbox coordination rule. |
| `EI-17122` | `papercusp`, `papercusp-public-site-pot` | Replication-liveness report vs unique-visitors analytics defect. |
| `EI-17123` | `papercusp`, `papercusp-public-site-pot` | Replication-liveness report vs engaged-visitors UI work. |
| `EI-4644` | `oddsmith-hive`, `papercusp` | Oddsmith role-fire failure vs Hello World replication-liveness report. |
| `EI-8869` | `operator:papercusp-workspace`, `papercusp` | Different replication-liveness fingerprints and divergent stored evidence; review before deciding whether this is same-root or distinct. |

No terminal, link, re-home, or delete action is proposed for this class in P-004.

## Class E — content-identical physical-twin candidates

The base table has **58 duplicated logical IDs / 116 physical rows** with identical title and body. Of those groups, 33 also have identical status and 25 have status drift that must be reconciled. Physical scope patterns:

| Physical scope pair | Groups |
|---|---:|
| `operator:papercusp-workspace` + `papercusp` | 43 |
| `papercup` + `papercusp` | 13 |
| `papercup-hive` + `papercusp` | 2 |

Candidate IDs:

`EI-1`, `EI-13196`, `EI-13197`, `EI-13205`, `EI-13236`, `EI-13237`, `EI-13238`, `EI-13305`, `EI-1435`, `EI-1629`, `EI-1700`, `EI-18184197281781732`, `EI-2205`, `EI-6706`, `EI-6707`, `EI-6708`, `EI-6765`, `EI-7019`, `EI-7532`, `EI-7690`, `EI-8867`, `EI-8868`, `EI-8870`, `EI-8871`, `EI-8920`, `EI-9023`, `EI-9024`, `EI-9025`, `EI-9036`, `EI-9037`, `EI-9038`, `EI-9039`, `EI-9198`, `EI-9199`, `EI-9242`, `EI-9243`, `EI-9244`, `EI-9245`, `EI-9246`, `EI-9262`, `EI-9263`, `EI-9264`, `EI-9265`, `EI-9266`, `EI-9267`, `EI-9268`, `EI-9269`, `EI-9270`, `EI-9411`, `EI-9412`, `EI-9413`, `EI-9414`, `EI-9415`, `EI-9416`, `WI-1993`, `WI-2017`, `WI-2063`, `WI-2124`.

These are migration candidates, not deletion instructions. P-005 must select the survivor from full origin/scope/federation/completion history, merge any differing metadata, and remove only the redundant physical row inside a dedicated migration.

## Reference-audit gate for P-005

The 69 colliding logical IDs (58 identical candidates + 11 divergent collisions) currently touch **94 `coord_links` rows** in `papercusp-workspace`; 62 IDs appear as a source and 3 as a destination. Four of those edges are `duplicates` and one is `relates`; the rest include tags/other polymorphic relations. The catalog also exposes ID-bearing columns in claims, subscriptions, audit, placement, task, attribution, release, and parent-link tables.

Before any physical migration, P-005 must:

1. Inventory and preserve/repoint references in `coord_links`, `coord_entity_subscriptions`, threads/posts, `work_items.parent_id`, `work_item_claims`, `feature_claims`, `claim_audit`, `task_ledger`, fleet/pot/hive placement, edit/git-sync attribution, release arrays, and any other catalog-discovered ID column.
2. Treat divergent ID collisions as an ID-rekey problem, not a duplicate-delete problem.
3. Choose a survivor for each content-identical group using origin, scope, federation HLC/timestamp, completion authority/evidence, state, assignee/progress, payload metadata, and existing links—not `min(ctid)` or newest-row alone.
4. Prove one physical row per intended logical ID after migration, while retaining both records for every divergent collision under distinct IDs.
5. Keep rollback anchored to snapshot `ee8d1d2dacd7b4522d3155fba6a1019d` and verify the restored copy before relying on it for an in-place recovery.

## P-005 proposed mutation totals

| Action class | Proposed count | Confidence |
|---|---:|---|
| Add structured duplicate link + terminal later exact duplicate | 1 | Confirmed exact title/identity |
| Review stable-signal pair, then link + terminal later row if evidence remains same-root | 1 | Probable same-root; strong stable-key evidence |
| Terminal source rows whose duplicate edge already exists | 17 | Confirmed structured relationship; per-row evidence still required |
| Dedicated migration candidates for redundant content-identical physical rows | Up to 58 | Candidate count only; survivor/reference reconciliation required first |
| Divergent ID collisions to preserve and rekey | 11 groups / 22 rows | Confirmed distinct content |

The maximum candidate reduction is therefore **77 logical/physical rows**, but that is not an authorized or safe bulk-delete number. Only 18 logical duplicate dispositions are presently confirmed (1 new exact + 17 existing structured links); the stable-signal pair is review-gated, and every physical-row action is migration-gated.

## No-mutation attestation

P-004 performed only source reads, plan/work-item reads, read-only Postgres queries, snapshot creation/listing, and this report write. It did not call `work_items:complete`, `work_items:link`, a state transition, SQL DML, or a migration runner. The next write-side phase is P-005.
