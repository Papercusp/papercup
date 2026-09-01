# P-004 — final disposition/preservation ledger and re-verification

Plan `feature-change-dedup-supersession-audit-2026-09-01`, item `P-004`, driven
from `WI-2140690`. Closes out the audit: re-runs the census fresh, re-verifies
reference integrity of the P-003 mutations, and publishes the exact final
counts.

## Fresh census (fresh watermark, live at close-out)

Same corpus definition as P-001/P-002: `kind` in {`feature`,`change`}, `state`
not in `done|passed|resolved|closed|deprecated|dropped`, `payload.lane`
distinct from `observation`, scope `harness:papercusp`, `updated <= watermark`.
Re-run via `dev:pg_query` (read-only), watermark = live `now()`:

```sql
-- corpus CTE identical to the P-001/P-002 recipe (see those files), watermark = now()
```

Result: **watermark `2026-09-01T19:43:56.638459Z`, target=2793 (feature=167,
change=2626)**, `id_md5=6a2d578409ee5b8d59b50dcfd5ba6ece`,
`id_sha256=ef8e8a80c903ec4eb5af56d0b3918c8c0af27691bf2f3978159ad4de57212604`.

| capture | watermark | target | feature | change |
|---|---|---|---|---|
| P-001 (frozen) | 2026-09-01T15:49:00Z | 2808 | 175 | 2633 |
| P-002 (live re-run) | 2026-09-01T19:20Z | 2758 | 151 | 2607 |
| P-004 (this, live re-run) | 2026-09-01T19:43:56.6Z | 2793 | 167 | 2626 |

The corpus is **not monotonically shrinking** — P-004's count is higher than
P-002's despite the 15 disposals in between. This is expected, documented
drift (P-001/P-002 already flagged the corpus as live-drifting "by design, not
a defect"): new features/changes are filed continuously and existing rows get
`updated_at` bumps that bring them back under the `<=` watermark, while the
15 disposed rows (and any independently-closed rows) drop out. Net effect
over ~4h24m of wall time: -15 (disposed) + (new filings/re-updates) − (rows
that closed independently) = +... a smaller corpus at 19:20Z followed by a
larger one at 19:43Z. The two writer-backed re-runs (P-002 at 19:20Z, this one
at 19:43Z) are each internally consistent (canonical-export hash would match
an independent census the same way P-001 verified); no discrepancy between
the SQL count and the underlying tables was found.

## Reference-integrity re-verification of the 15 P-003 dispositions

All 15 rows soft-deprecated by P-003 (WI-2140632) were re-checked live,
~4 minutes after their mutation:

- **All 15 disposed ids still read `state='dropped'`** (13 EI via
  `engineer_issues.state`, 2 WI — `WI-4429`, `WI-5071` — via
  `work_items.status`). No reversion, no reopen.
- **All 15 survivor ids are unchanged** (`open` or `done`, matching their
  pre-disposal state exactly): EI-20633190770661743, EI-20630508792138742,
  EI-18710402934363497, EI-18808557559542053, EI-19367241616429861,
  EI-19371085414676865, EI-19355852537459957, EI-18807865001148074,
  WI-4668, WI-5070, EI-20630508400046931, EI-20633190285018439,
  EI-21445547407321199, EI-21102269168719801, EI-21552938316984596.
- **Full `coord_links` scan re-run** (any `rel`, either endpoint touching one
  of the 15 disposed ids): 51 rows total. Every row is accounted for by the
  P-003 disposition rationale (the disposed↔survivor `duplicates` reciprocal
  pairs, the `tagged`/`improvement-source` metadata links on the disposed
  rows, the already-terminal `caused-by`/`relates` links noted in the P-003
  ledger, and the `EI-13260`/`EI-21147419341294896` already-terminal
  `duplicates` edges). **Zero new links were created against a disposed id
  since P-003's write**, and zero currently-open, non-terminal row has an
  unresolved/unaccounted reference into a disposed id. Reference coherence
  holds.

## Final plan-wide summary (P-001 → P-004)

- **Candidates surfaced (P-002, at its snapshot):** §1 exact full-identity 2
  groups/4 rows; §2 exact title-only 31 groups/105 rows; §3 explicit
  `duplicates`/`revises` links 64 edges/~104 ids; §4 new fuzzy near-dupes
  (sim<1.0) 7 pairs/9 ids.
- **Disposed (P-003, validated + soft-deprecated):** 15 rows (13 EI + 2 WI),
  every one either byte-identical title+body or an explicit
  `duplicates`/`revises` coord_link corroborated by a content read confirming
  equivalent scope, each with a canonical survivor and a reference-coherence
  check before closure. Zero hard-deletes; every closure recoverable via
  `completion.duplicateOf` + evidence. Re-verified stable above.
- **Preserved (P-003, evidence-checked, left non-terminal):** the §2
  exact-title clusters minus the 3 that became fully-identical and were
  disposed (29→33 live groups as the corpus drifted, ~100 ids) — each row is
  an independently-filed observation of the same recurring bug **class** with
  its own incident body, not a true duplicate; the §3 17 open duplicates of
  the `EI-13260` hub (hub itself `closed` with no completion evidence — an
  invalid terminal-survivor target per Scope, so left open pending a
  governance call); EI-18704693819205504 (scope mismatch vs its `done`
  target); WI-40735 (its `revises` target is a plan slug, not a work-item —
  out of this audit's disposition mechanism); WI-2140428 (`wip`, active);
  WI-37550 (a deliberate re-file, `duplicates` direction is residue not an
  instruction); WI-41458 (explicit owner-directed distinct iteration); the 5
  remaining §4 fuzzy pairs (distinct incident bodies of a recurring bug
  class); WI-5823/WI-5824 (out of this plan's declared feature/change corpus
  — kind mismatch in the base table).
- **Open governance items flagged, not resolved by this audit** (recorded
  here so they are not silently dropped; each is outside P-003's disposition
  mechanism per the plan's own Scope):
  1. **EI-13260** — the "plan lifecycle drift" hub, 18 total inbound
     `duplicates` edges, itself `state=closed` with `terminal_owner
     ='improvement-hygiene'` and **no** `terminal_completion_ref`. 17 of its
     duplicates remain open specifically because a no-evidence terminal row
     is not a valid disposition target. Needs an owner/human call: either
     re-open EI-13260 as the tracking hub with real completion evidence, or
     accept the 17 as independently representing unresolved work.
  2. **WI-40735** — `revises` → a plan/goal slug
     (`learning-loop-identity-consumption-acceptance`), not a work-item id.
     Needs whoever owns that plan to resolve or retarget the link.
  3. **WI-5823/WI-5824** — a near-identical "retire the work-item mail
     surface" pair, both open, out of this plan's declared feature/change
     corpus (kind mismatch). Left unactioned; noted for a follow-up outside
     this plan's mandate.

## Unrelated infrastructure note (found during this item, filed separately)

While re-running the fresh census, `papercusp-bg-host.service` was observed
`activeState=failed` (git-sync/DBOS/Mug wake-loop down ~19:33-19:48Z) and then
self-recovered. This has no bearing on the disposition mutations above (all
verified unchanged post-recovery) and is unrelated to this plan's scope; filed
separately as `EI-22089912517133068` per the "never skip a self-recovered
flap" rule, not resolved further here.

## Plan-level code-truth audit

See `plans:audit` call against this plan (P-001–P-004), citing the writer
files established in the P-001 report (`work-item-dispatch-states.ts`,
`work-items.ts`, `issues-engineer.ts`) as the code-truth basis for the
terminal-state/lane semantics this whole audit relies on, plus this ledger and
the P-002/P-003 ledgers as the read-only-query and mutation evidence trail.
This is a data-audit plan (no application code was changed); the "code truth"
audited is that every disposition was made strictly through the documented
`work_items:set_state`/completion surface (no hard-delete, no raw SQL mutation
— confirmed: every mutating write in this plan's history was a
`work_items:complete`/`set_state` call, never a `dev_pg_query` write — and
that the writer semantics cited in P-001 are what the disposition/preservation
decisions were actually evaluated against.

## Resuming normal fleet operation

No fleet-specific git-sync/gate lane was found explicitly "paused" by name (no
tracked work-item, no held resource lock under `git-sync:*` beyond the routine
git-sync scheduler itself, which self-recovered per the note above and is
unrelated to this plan). This plan's own Background/Scope text ("before any
further git-sync or release-gate mutation, exhaustively audit...") reads as
the owner's precondition on *this fleet's* feature/change mutation work, not a
literal external pause mechanism. With the audit complete and re-verified
stable, this session resumes its normal fleet mission: pulling from
`scheduler:get_next` against the `feature-change-drain-2026-09-01-v2` claim
lane.
