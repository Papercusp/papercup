# P-003 — validated disposition ledger

Plan `feature-change-dedup-supersession-audit-2026-09-01`, item `P-003`, driven
from `WI-2140632`. Validates every candidate in the P-002 ledger
(`scratchpad/feature-change-dedup-supersession-audit-2026-09-01-p002-candidates.md`)
against full work-item bodies, inbound/outbound coord_links (all `rel` types,
not just `duplicates`/`revises`), plan coverage, assignee/claim state, and
implementation/completion lineage, before disposing anything. **Similarity
alone was never treated as authorization** — every soft-deprecation below cites
either byte-identical title+body, or an explicit `duplicates`/`revises`
coord_link corroborated by a content read confirming equivalent scope, plus a
reference-coherence check (no live item stranded by the close).

15 rows soft-deprecated (`state: dropped`, `completion.duplicateOf: <survivor>`,
`completion.summary`: evidence). All verified post-write via direct SQL:
13 EI + 2 WI deprecated (`state='dropped'`), all 15 survivors confirmed
unchanged (`open`/`done`). No work-item was hard-deleted; every closure is
recoverable via its `completion.duplicateOf` + summary evidence.

## Disposed (survivor ← deprecated, evidence)

1. **EI-20633190770661743 ← EI-21034970555768887** — exact title+body identity
   ("Gym champion promoted: judge@h-pao cycle 4"); no assignee/plan/blocking
   links either side; earlier row kept.
2. **EI-20630508792138742 ← EI-21032654515383704** — exact identity
   ("…reviewer@tx cycle 1"); same checks.
3. **EI-18710402934363497 ← EI-18652033720958396** — explicit `duplicates`
   link; both propose a content-hash+symbol-anchor fix for the same
   path-anchored insight-staleness watchdog. **Survivor flipped from the
   naive earlier-created choice**: EI-18710402934363497 is the target of 14
   inbound `caused-by` coord_links from other issues and had to stay live to
   keep those references coherent; EI-18652033720958396 carried only the
   reciprocal `duplicates` edge.
4. **EI-18808557559542053 ← EI-19476667582235542** — explicit `duplicates`
   link; both propose demoting the plan `lifecycle` field to a
   computed/read-derived value (identical "cluster A" mechanism, distinct from
   the "cluster B" gate+escape-hatch proposals below). Sole inbound ref to the
   deprecated row is from EI-21147419341294896, itself already terminal
   (`dropped`) — nothing live stranded.
5. **EI-19367241616429861 ← EI-19367242336402442** — explicit `duplicates`
   link, filed 1s apart; identical green-checkpoint skew-detector
   OR-combined blob-hash-oracle proposal. No inbound refs to the deprecated
   row.
6. **EI-19371085414676865 ← EI-19378791966545578** — explicit `duplicates`
   link (~2h apart); identical out-of-process reaper/GNU-timeout mechanism
   for vitest event-loop hangs. Only inbound ref is an informational
   `relates` from WI-39986 (non-blocking).
7. **EI-19355852537459957 ← EI-19403437795858863** — explicit `duplicates`
   link (~13h apart); identical write-time-gate + logged "fork-debt" escape
   hatch mechanism ("cluster B", distinct from #4's "cluster A" — confirmed
   NOT cross-linked to #4, so both clusters preserved as genuinely distinct
   proposals). Sole inbound ref to the deprecated row is from
   EI-21167901091090750, already terminal (`dropped`).
8. **EI-18807865001148074 ← EI-20607941335084548** — explicit `duplicates`
   link; survivor is `state=done` with a real agent `terminal_owner`
   (credible completion, not a hygiene bulk-close). Identical failure mode
   (a carry-note's prose completion claim contradicted by live
   plan-item/work-item state); survivor's shipped fix (resolve every
   referenced id to live status at assembly time) directly addresses the
   deprecated row's report.
9. **WI-4668 ← WI-4429** — explicit `duplicates` link; survivor is
   `state=done`, `terminal_completion_ref`="Reconciled via plan-item status:
   agent-operability-improvements-implementation-2026-07-13#P-017 completed".
   WI-4668's own scope text explicitly names WI-4429 as one of the items
   "integrated and independently live-verified" (write-time admissibility
   preview — WI-4429's exact ask).
10. **WI-5070 ← WI-5071** — exact title+body identity (feature-family, outside
    the `engineer_issues` view — verified directly against
    `harness_shared.work_items`), filed ~104s apart. Neither claimed nor
    plan-linked.
11. **EI-20630508400046931 ← EI-21032653764630066** — exact identity
    ("…validator@beta cycle 1"), newly-identical since the P-002 snapshot
    (corpus drift; confirmed via a `count(DISTINCT body)` aggregate over the
    live corpus, not present as an exact match at the P-002 capture).
12. **EI-20633190285018439 ← EI-21034969848193785** — exact identity
    ("…worker@h-pao cycle 3"), same drift class as #11.
13. **EI-21445547407321199 ← EI-21445553292915949** — exact identity ("Tool
    schema mismatch encountered during WI-41055 supervision"), filed 6s
    apart.
14. **EI-21102269168719801 ← EI-21179583380286320** — near-duplicate title
    (`events:await producer_health.kind` schema mismatch); deprecated row's
    body is **empty**, contributing zero unique evidence beyond the
    populated survivor.
15. **EI-21552938316984596 ← EI-21307735047443422** — near-duplicate title
    (`improvements:capture` numeric-status rejection); deprecated row's body
    is **empty**, same rationale as #14.

## Preserved (evidence-checked, left non-terminal)

- **§2 exact-title-only clusters (29 of 31 groups; 2 groups gained since P-002
  = 33 total, minus the 3 that turned out fully-identical and were disposed
  above as #11–13)** — verified via `count(DISTINCT body)` aggregate: every
  remaining group has `distinct_bodies == n` (every row's body is unique).
  These are independently-filed observations of the same recurring
  tool-call-failure / gym-champion-escalation bug **class**, each carrying
  its own incident context (different WI being worked, different composition
  error) — exactly the "distinct scope, unique evidence" carve-out in the
  plan's Scope. Deliberately not enumerated per-row here (31→33 live groups,
  ~100 ids); reproducible via the P-002 ledger's §2 query plus the
  `count(DISTINCT body)` aggregate above.
- **§3 — 17 open items whose sole disposition-relevant link is `duplicates
  EI-13260`** (EI-15209, EI-16253, EI-16781, EI-17086, and 13 more `EI-181xx`
  `EI-193xx`/`EI-194xx` ids) — **not disposed**. EI-13260 (the "plan lifecycle
  drift" hub, 18 total incoming `duplicates` edges) is itself `state=closed`
  with `terminal_owner='improvement-hygiene'` and **no**
  `terminal_completion_ref` — i.e. closed by a hygiene/consolidation sweep
  with **no evidence the underlying fix was ever implemented**. Per Scope
  ("preserve any row with… an uncertain survivor"), a terminal row with no
  completion evidence is not a valid "surviving canonical" target, so none of
  its 17 open duplicates were closed. **Flagged for a human/owner decision**:
  either re-open EI-13260 as the tracking hub, or accept these 17 as still
  representing unresolved work.
- **EI-18704693819205504** (duplicates EI-18704153588567089, `done`) — scope
  mismatch: the survivor's shipped fix is a build-time
  generate/check-consistency guard (derived-truth ladder tier 1/2); this
  row's ask is telemetry-driven *adaptive* head-set derivation, a materially
  larger, unimplemented scope. Preserved.
- **WI-40735** (`revises` → `learning-loop-identity-consumption-acceptance`)
  — the link target is a plan/goal slug, not a work-item id; out of this
  audit's disposition mechanism (which resolves duplicate/superseded
  *work-items*). No action; flagged for whoever owns that plan link to
  resolve or retarget it.
- **WI-2140428** (`revises` → WI-1729084, `done`) — WI-2140428 is currently
  `wip` (actively claimed, live implementation in progress). Never a
  disposition candidate while in-progress.
- **WI-37550** (`duplicates` → WI-37545, `dropped`) — WI-37550's own title/body
  says it is a **deliberate re-file** of WI-37545 after the claim floors
  classed WI-37545 as "stale residue of completed work" post-P-006. The
  `duplicates` link direction is residue of the re-file, not an instruction
  to drop WI-37550 too — WI-37550 is the surviving continuation. Preserved.
- **WI-41458** (`revises` → WI-41421, `done`) — explicit owner-directed
  (`[owner 2026-08-25 interactive]`), open-ended iteration task,
  legitimately distinct from the completed WI-41421 it follows on from.
  Preserved.
- **WI-5823/WI-5824** (near-identical "retire the work-item mail surface"
  pair, both open) — **out of this plan's declared corpus** (kind is not
  `feature`/`change` for WI-5823 in the base table), so left unactioned here;
  noted for a follow-up outside P-003's mandate.
- **§4 remaining 5 fuzzy pairs (EI-21105767650350924/EI-21437105324720310,
  EI-21682233754672379/EI-21709351942929077, and 3 of the 4
  `EI-21100293164081665`-cluster pairs)** — every one has a distinct,
  substantive body describing a different incident/context of the same
  recurring tool-schema-mismatch bug class; preserved for the same reason as
  the §2 clusters above (recurrence evidence has value; the improvement
  pipeline's own probation/promotion mechanism depends on independent
  re-reports).

## Reference-coherence check

Ran a full `coord_links` scan (all `rel` types, not just
`duplicates`/`revises`) against every id in the disposal list before writing
any completion, specifically to catch inbound `caused-by` hub references
(caught #3 above) and inbound `duplicates` from other still-open rows (all
resolved to already-terminal sources, confirmed by direct query). Post-write
verification query confirms all 13 EI + 2 WI targets read `state=dropped` /
`status=dropped` and all 15 survivors are unchanged (`open` or `done`).

## For P-004

- Re-run the P-001/P-002 census recipes fresh (corpus is live-drifting by
  design — expected, not a defect).
- The EI-13260 hub (17 open duplicates of a no-evidence-terminal row) is the
  one open governance question this audit surfaced; worth a plan Decision or
  an owner call rather than silent carry-forward.
- WI-40735's plan-slug `revises` target and the WI-5823/WI-5824 (task-kind,
  out-of-corpus) pair are noted but unresolved — out of P-003's disposition
  mechanism, in scope for whoever owns lifecycle-drift/mail-surface cleanup.
