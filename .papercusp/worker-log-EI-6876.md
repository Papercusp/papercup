# worker-log — EI-6876 (auto-implement)

## Bug
"Auto-implement dispatch for EI-6569 died without resolving — orphaned worker."

## Root cause (evidence-backed)
Queried the dispatch ledger for EI-6569:
`worker exit 1 after 866s [no resolve recorded; attempt charged]: API Error: Server error mid-response. The response above may be incomplete.` — resolved_by `worker-exit-backedge`.

The worker died on a **transient upstream model-API 5xx** ("Server error mid-response").
`isEnvFailureExit` (implement-worker-exit.ts) only recognized rate-limit/auth/quota/
connectivity + context-overflow + sub-floor DOA — NOT upstream 5xx. So a transient
provider error:
1. **charged the attempt** (drains the per-item cap → eventually routes a fixable item to
   human-only), and
2. was tagged plain `worker-exit-backedge`, which `isLaneBreakageOrphan` (orphaned-dispatch.ts)
   treats as "lane broken" → filed a major EI. That EI **is EI-6876** — the exact
   self-amplifying noise loop the code comments (implement-worker-exit.ts L222–226 /
   orphaned-dispatch.ts L165–171) warn about.

## Fix
Added 5 transient-upstream-5xx patterns to `ENV_FAILURE_PATTERNS` in
`packages/operator-core/lib/harness/improvements/implement-worker-exit.ts`:
`/server error/i`, `/overloaded/i`, `/service unavailable/i`, `/bad gateway/i`,
`/gateway time-?out/i`. Now a transient 5xx classes as env → attempt rolled back +
tagged `worker-exit-backedge-env` → `isLaneBreakageOrphan` returns false → excluded from
the "lane broken" signal (no more false EI). Closes both harms.

Purely additive to a pure classifier — no signature/behavior change for any other path.

## Regression tests (implement-worker-exit.test.ts)
- 6 new `it.each` classifier cases (server-error-mid-response, 529/overloaded, 500, 503,
  502, 504) — all class env at a long (non-DOA) runtime.
- 1 new back-edge test reproducing EI-6569's exact death: attempt rolled back to 0 +
  tagged `worker-exit-backedge-env`.
- Widened the shared `it.each` runtime to well past the DOA floor so env-signature
  matching is proven independent of the DOA rule (strengthens the existing cases too).

## Verified
- `npx vitest run lib/harness/improvements/implement-worker-exit.test.ts` → 29 passed
- consumers: `orphaned-dispatch.test.ts` + `policy.test.ts` → 72 passed
- whole dir `lib/harness/improvements/` → **874 passed / 41 files**, no regressions.

## Scope / gate note
The fix touches `improvements/**` (a protected path / "the loop's own code"). Verified
both `papercusp-queen-full-autonomy` and `papercusp-improvement-auto-implement` are ON in
`papercusp-workspace` — the owner-ratified grant that lifts the protected-path bar for
exactly this kind=bug, with the release gate (blueprint + tests + release-manager) as the
net. That grant is why the item was dispatched auto-eligible. Change lands via the release
gate, never in-process.

## For the validator to re-verify
- Confirm the 5 new patterns don't over-match any genuine could-not-fix output shape
  (they're named 5xx shapes, not bare status numbers, to avoid false positives on worker
  output that merely contains "500"/"503").
- Confirm end-to-end that a `-env`-tagged death is excluded from the lane-broken signal
  (isLaneBreakageOrphan L185).
