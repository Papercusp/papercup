# P-003 — candidate union and initial dispositions

This is an **incomplete audit**, recorded on 2026-09-05 for WI-2146347.
The candidate union is complete and validated; 36 rows have initial reviewed
dispositions. No manual cleanup has been applied. P-003 remains open.

The frozen population is the P-002 export at `2026-09-05T17:09:11.920530Z`.
Revision 16 and the fleet freeze were left untouched. No member was woken or
restarted, and the bulk run was not read in this continuation.

## Exact coverage

| Population | Rows |
|---|---:|
| Frozen feature/change IDs | 2,261 |
| Original candidate signals | 179 |
| Additional IDs from root/title/lineage overlays | 482 |
| Combined candidate union | 661 |
| No generated signal; still unreviewed | 1,600 |
| Initially reviewed candidates | 36 |
| Candidates still unreviewed | 625 |
| All rows still unreviewed | 2,225 |

The union includes 288 overlapping evidence groups and 32 lineage-signal rows.
Group membership is a review cue; groups cannot be added together to count rows.
Absence of a signal does not establish relevance, uniqueness or completion.

The read-only builder verifies the three input hashes, all 2,261 source files,
the exact original ID set and its order-dependent SHA-256, every group member,
the independently recomputed union, and all preserved floors. The persisted
artifact was then reconstructed and compared field-for-field.

- Frozen ordered-ID SHA-256: `62b68aa60cc8e1a93b758b793709878779e0df896b542be518cab1f0977af1de`
- Candidate ordered-ID SHA-256: `9758c98908fcd237e5fbf5befffdcbc4567ab5cc90285b56df40e8bac5b9ba00`
- Candidate-union file SHA-256: `d4a1cbbaa5d2e91da5c66305d6905c87f10a417c313826a6d9bdd992be1d8657`

## Initial findings

The four exact title/summary pairs are gym champion generalization requests.
Their structured champion identities also match. The September 1 audit closed
keyed copies while preserving older rows without those keys. New keyed copies
then appeared. The producer emits a stable `gym-champion:<harness>:<role>` key;
the capture writer coalesces a matching open key before its fuzzy/force path.
An unkeyed survivor cannot absorb that producer event.

| Unkeyed duplicate proposal | Proposed keyed survivor |
|---|---|
| EI-20630508400046931 | EI-22377526107135174 |
| EI-20630508792138742 | EI-22377527698094986 |
| EI-20633190285018439 | EI-22419356078158280 |
| EI-20633190770661743 | EI-22419357754929586 |

These are proposals, not merge receipts. Historical duplicate edges point to
the older rows, so P-004 must preserve or redirect both reference directions
and retain the recurrence key and occurrence evidence before any closure.
D-006 records this rule. The recurrence defect and required guard are filed
and held as EI-22445535639835161; the source fix is not implemented yet.

Other initial dispositions:

- EI-20574914614868579 is preserved as an independent residual follow-up.
  Its parent `harden-shared-hive-to-256-peers-2026-06-29#P-003` is done for
  the steady-state goal, but the full open record explicitly scopes remaining
  log-removal performance work: retain per-winner provenance so removal can
  re-derive only affected keys. Parent completion is not evidence that this
  narrower optimization was implemented or superseded.
- WI-149547, WI-149550 and WI-149552 are same-trigger supersession
  candidates, not generic same-item duplicates. Their blocked run-1285 items
  have matching run-1289 completions (WI-478132, WI-478133 and WI-478139)
  for the same Calendar dedupe identity and item-text hashes. The second
  terminal sibling for each belongs to a different test trigger and is not a
  canonical match. P-004 must still resolve the active run-lane blockers and
  preserve each per-run condition/reference history before any mutation.
- Three events:catalog complaints are candidates for already-implemented
  closure: current code accepts `q`, `pattern` and `limit`, and bounded live
  read calls accepted both query spellings. Existing regression assertions
  were inspected; their test suite was not run in this audit continuation.
- Five plans:list complaints describe the same missing `q`/title-topic filter.
  They form a proposed consolidation under EI-21525538779965063. Existing
  plans:search already serves keyword/title/slug lookup, so the remaining
  question is the discovery contract. Preserve every reporter's evidence and
  recurrence identity before merging; do not create another search surface.
- Seven other tool-call rows are preserved as distinct subcases or ambiguous
  evidence. One coord:feed report lists catalog-only accepted fields; its
  original invocation needs verification before treating it as a feed defect.
- WI-3509, WI-4141, WI-42228 and WI-42231 retain their holds/dependencies.
  A missing indexed plan item does not prove that their obligations vanished.
- Five rows were assigned at the watermark and recorded terminal with payload
  completion evidence in the existing 17:50 lineage snapshot. They are
  preserved as external progress, not counted as closures by this audit.

## Artifacts and continuation

- `feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p003-union.mjs`
  reproduces and validates the union; it only reads files and prints output.
- `feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p003-candidate-union.json`
  contains one entry per frozen ID, signal provenance, original preservation
  floors, payload protection markers and frozen-source hashes.
- `feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p003-dispositions.json`
  contains all 2,261 IDs, distinguishing the 32 initial reviews from the 2,229
  unreviewed rows, with reasons, references and conditions for later cleanup.

Activation re-audit #3 covers D-006 at plan revision 10, carrying the original
14 requirements and adding M-015. It is not a completion audit.

Next: continue full-record reviews of the remaining lineage exceptions and
shared-root clusters, then cover all no-signal rows. Finish P-003's complete
ledger before P-004 validates and applies recoverable cleanup. P-005 performs
the final population/reference checks and delivers the complete report.
