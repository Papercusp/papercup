# code:run resolving a different claim-spec than a direct call is a RACE, not an identity bug
URL: /internal/docs/agent-insights/code-run-does-not-diverge-scheduler-identity

scheduler:get_next/get_claim_spec via code:run vs a direct MCP call can show a different fleetScope/specId back-to-back — verified this is NOT code:run carrying a different identity (ctx/ownerId is provably identical, regression-tested), it is the fleet leader's concurrent claim-spec write landing between the two reads.

## Symptom (EI-13324)

A fleet member called `scheduler:get_next { harness: 'papercusp' }` twice, back-to-back, with
identical args — once via `code:run` (`tools.scheduler.getNext(...)`), once as a direct tool
call. Both missed, but the `fleetScope` in the two miss payloads named a **different** claim
spec: the `code:run` call showed a per-bee spec (`source:'cup'`), the direct call showed the
inherited fleet-level spec (`source:'fleet'`). The natural (and wrong) conclusion: "`code:run`'s
execution context carries a different scheduling identity than my own session."

## What it actually is: NOT an identity divergence

Verified live (2026-07-19), two ways:

1. **Empirical**: called both `coord:whoami` (identity resolved purely from `ctx`, no explicit
   id arg — the same shape `scheduler:get_next` uses internally) and `scheduler:get_claim_spec`
   directly *and* via `code:run`, back-to-back, same session. `ownerId` / `fleetSlug` /
   `specId`/`revision` were byte-identical both times.
2. **Code + regression test**: `code:run`'s inner-call rebinding (`bindInnerDispatch`, WI-1411)
   only rebuilds `ctx` when the call's *effective workspace* differs from the outer ctx's (the
   EI-30 per-call `{ workspace }` hop for an unscoped superuser) or the tool is `crossWorkspace`.
   In the common case — no `workspace` arg override, which is exactly this bug's repro
   (`{ harness: 'papercusp' }`, no `workspace` key) — it dispatches under the **exact same `ctx`
   object reference**, not a rebuilt one:
   `code/run.test.ts` pins this with `expect(result).toBe(outerCtx)` for both a concrete-workspace
   ctx and an unscoped-superuser-with-no-override ctx. `resolveAgentIdentity` (identity.ts) reads
   only plain fields off that same object (`uiClientId`, `isSuperuser`, `sigVerifiedSpawn`,
   `principal`), so `ownerId` cannot differ between the two dispatch paths when no workspace hop
   fires. `getClaimSpecRecord`/`getNextForBee` (claim-spec-store.ts) always query a **fresh**
   `getOrgPg().sql` connection — no `ctx.tx` read, no cache/memo layer keyed on tool+args — so
   there is no snapshot-staleness or cross-caller-cache mechanism either.

## What actually explains the divergence

The two "back-to-back" reads are still two separate round-trips with a real (if small) gap
between them. The reporter's own follow-up confirms it: "a direct call succeeded and
`claimedUnder` showed `backlog-drain-bee`@1 (**the leader had since pushed a per-bee spec
fix**)." The fleet leader concurrently wrote a per-bee claim spec (`scheduler:set_claim_spec`)
for this same `cupId` in the same window — an ordinary TOCTOU race between a live write and two
close reads, not a per-transport identity fork. Two consecutive reads of a row that is being
concurrently written can legitimately observe different states; that is expected, not a defect.

## The runbook

* Before suspecting `code:run` of resolving a different agent identity, cross-check with
  `coord:whoami` (or `scheduler:get_claim_spec { cupId: <your ownerId> }`) called BOTH ways —
  if they match (they will, per the regression test above), the divergence you saw was a race,
  not an identity fork.
* A `fleetScope`/`claimedUnder` mismatch between two near-simultaneous reads is best explained by
  a **concurrent claim-spec write** (the leader re-steering via `scheduler:set_claim_spec`) landing
  between them — check `updated_at`/`revision` on the two reads; if the later one has a higher
  revision or a fresher `updatedAt`, that is the whole explanation.
* `code:run` inner calls only rebind `ctx` (workspace/tx/principal) when the call's *effective
  workspace differs from the outer ctx's* — see `bindInnerDispatch` in
  `packages/operator-core/lib/agent-tools/code/run.ts`. Absent an explicit per-call `{ workspace
  }` override (or a `crossWorkspace`-flagged tool), the exact same `ctx` — and therefore the exact
  same resolved `ownerId` — is used for every inner call in a batch.
