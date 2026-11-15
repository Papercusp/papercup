# Shared reference system — acceptance bar amendment, revision 12

Rubric: `shared-reference-system-acceptance`. Plan: `shared-reference-system-2026-11-13`.
Prior bar set: `1f96cbe96dff…` (revision 11). Applied bar set: `e37b891e8172…` (revision 12, receipt `srs-acceptance-rev12b-20261115-apply1`, committed 2026-11-15T02:46Z; plan revision 87 → 88).
Outside-lineage pre-apply review: approved in `thread-post:1230056` (consult `conv-mwh85em8-0000-af9894feb75549089cc7c55b66ef2863`) over preview `thread-post:1230046`, source hash `sha256:99694bf4…6308`. The reviewer found all six changed bars (R-3, R-4, R-12, R-13, R-19, R-32) to be net strengthenings. Grader note from that review: for R-3/R-4, confirm the reported operative limit N matches the real transport and result-door limit.

## Source critiques

Two independent bar critiques were answered on consult `conv-request-496c48897afe18d9773933c2941eb860e18a039dd2744662666de7de57dfca74` against the revision-11 bar set:

- su-ca95c342, `thread-post:1229620`: four blockers.
- su-fae52ba7, `thread-post:1229660`: four blockers.

The eight findings reduce to four classes.

| Class | Findings | Disposition |
|---|---|---|
| R-3 and R-4 promise arbitrary-size units inline and forbid continuation | lossless-r3, unbounded-inline-impossible | Accepted, bars rewritten |
| R-13 is proved by two large samples only | lossless-r13, r13-boundary-proof | Accepted, method rewritten |
| R-12 requires live outcomes but declares only the integration layer | plane-r12, r12-live-plane-mismatch | Accepted in part; same class fixed on R-19 and R-32 |
| Spec clauses do not all pin revision 11 | projection-r10, spec-projection-unproven | Accepted: the rev-11 doc overclaimed, corrected below |

## R-3 and R-4: whole units, automatic remainder

A universal "any size, inline, never continued" cannot hold, because every recipient has a finite context. It also contradicts the lossless-data contract, which requires explicit omission and a recovery path that consumers actually follow.

The owner's intent (`session_turn:codex:01a1cfda…:5` and `:10`) was to stop shortening that forces later tool calls. Both bars now require the following:

- Whole, intact units, with no fixed cap on reference count or unit size.
- When one delivery cannot carry everything, that delivery states exactly what follows.
- The remainder arrives automatically in ordered, announced parts. The recipient takes no action and makes no further call.
- Nothing is truncated, summarised or replaced by a pointer.
- A part boundary never splits a unit's identifier.

The proof runs at N-1, N and N+1 of each operative limit and across at least three parts. R-3 adds three citation orders. Both bars require a real process restart mid-delivery with no loss or duplication.

## R-13: boundary, burst and restart proof

The proof covers:

- Messages of N-1, N and N+1 bytes at the transport limit, plus one of at least 3N.
- Bursts of seven, eight and nine messages around the retired eight-message cap, plus one of at least 25.
- A real process restart mid-message and again mid-burst, after which every part and message arrives exactly once and in order.

## R-12, R-19, R-32: live verdicts only

The test-layer vocabulary is `unit`, `integration`, `e2e`, `llm` and `browser`. It has no live layer. These three bars already declare evidence plane `live` and runtime `release-operator`. The method now states the split:

- The integration layer proves only the check machinery against fixture data: query pinning, positive control, per-row emission to the results ledger, and an `unknown` result for a missing or truncated run record.
- Verdicts come only from live run records.

R-12's bar adds one rule: a row whose run record is missing, truncated or unpinned is rated `unknown`, never `healthy`.

## Retraction: the revision-11 projection invariant

The revision-11 amendment doc said every AUTO-BAR clause would be regenerated from revision 11. It also said activation readiness requires `sourceBar.rubricRevision = 11` and the rev-11 bar-set hash on every clause.

**That was wrong.** A full census on 2026-11-14 at 23:35Z, over all 39 bar-derived clauses on `harness_shared.plan_spec_clause_revisions` at their current revision, found:

- Only 12 clauses pin revision 11.
- 3 pin revision 8, 18 pin revision 9 and 6 pin revision 10. Each pins the revision in which its bar last changed.
- For all 39 clauses, `source_bar_hash` equals the current criterion's `barHash`, and every bar has a clause.

The amend regenerates only the clauses whose bars change. The readiness check described in revision 11 does not exist.

The operative invariant is content currency:

1. Every bar has exactly one active AUTO-BAR clause.
2. That clause's `sourceBar.barHash` equals the current criterion's hash.
3. Its `sourceRubricRevision` is the revision in which that bar last changed, which is never later than the current rubric revision.

The revision and bar-set pins record provenance, not currency. After the revision-12 apply, the same census must show 39 of 39 matching hashes. The six changed bars pin revision 12.
