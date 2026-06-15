# EI-207 worker log — plan doc silently reverted to old bytes, no recorded revision

## Verdict: FIXED (already fixed by the EI-117 work; regression test added)

## What the bug was
EI-207: on 2026-06-09 23:00 the `harness_shared.harness_plans` row for
harnesses-tab-hive-model reverted to bytes byte-identical to revision seq 2 (the
original hand-off) while `plan_revisions` still listed all 21 revs intact — the
live row diverged BELOW its own recorded head, and the reverting write recorded
no revision (so it was NOT a `plans:*` verb; it was the federation projection
applying a stale remote op).

## Root cause = the EI-117 stale-replay defect
A LOCAL plan write (via `withPlanLock`) never advanced `fed_ts`, so a
replayed/old federated op LWW-beat the newer local content
(`projections/harness-plans.ts` whole-blob path: `EXCLUDED.fed_ts >= fed_ts`,
and a NULL local clock let anything through). The "version 91 vs 21 revisions"
clue is just remote applies bumping `version` without authoring a revision —
expected, not itself the harm.

## Why it's already fixed
The EI-117 central fix landed **2026-06-09 23:50** — ~50 min AFTER this incident:
- mig `214-federated-fed-ts-local-stamp.sql`: a BEFORE INSERT/UPDATE trigger on
  every CDC table that stamps `fed_ts = clock` + resets `origin='local'` on any
  local write (and respects a projection apply, which moves `fed_ts`).
- projection writers dropped the `OR EXCLUDED.fed_ts IS NULL` clobber disjunct.
- `TableProjection.skipOwnOps` (own-log echo breaker).
So a stale/old federated op can no longer beat a freshly-stamped local write.

Note on the issue's proposed "contentHash CAS": a federated doc's concurrency
model is LWW-by-`fed_ts`, NOT CAS-by-hash (hash CAS would reject legitimate
remote merges). The `plans:*` USER write verbs already have CAS
(`evaluateSetContent`); the federation path correctly uses LWW, now made honest
by mig 214. That achieves the real requirement: a stale write cannot silently
revert newer content.

## What I changed
Added ONE regression test (no production code change needed — the fix is in):
`packages/operator-core/lib/agent-tools/plans/__tests__/ei207-stale-revert-revision-spine.integration.test.ts`
It proves the guard through the surfaces EI-207 named — the real `withPlanLock`
write path + the `plan_revisions` spine (the sibling
`ei117-replay-revert-guard.integration.test.ts` only uses raw SQL):
- build 3 recorded revisions, replay a stale federated op carrying the ORIGINAL
  bytes (ts < head's fed_ts) → live row stays at HEAD, origin stays `local`,
  revision spine intact and head == live content hash.
- sanity: a NEWER federated op (ts > head fed_ts) DOES apply — proving the guard
  discriminates on ts, not vacuously blocking everything.

## Tests run (green)
- `npx vitest run --config vitest.integration.config.ts lib/sync/hyperbee/__tests__/ei117-replay-revert-guard.integration.test.ts` → 6 passed
- `npx vitest run --config vitest.integration.config.ts lib/agent-tools/plans/__tests__/ei207-stale-revert-revision-spine.integration.test.ts` → 2 passed
- `npx tsc --noEmit` (packages/operator-core) → see resolve

## For the validator to re-verify
- Confirm both integration tests above are green.
- Confirm the framing: EI-207 == EI-117 class, fixed by mig 214 (timestamps in
  this log), regression added at the verb+spine level. No protected surface
  touched (no migration written, no projection/code change — test-only).
