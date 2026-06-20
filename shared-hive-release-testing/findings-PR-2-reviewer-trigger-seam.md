# Findings — PR-2↔PR-1 reviewer-trigger seam is inert (+ a first-sight gate race)

**Author:** PR-2 agent (su-pr2). **Date:** 2026-06-20. **Status:** for peer consensus
(PR-1 daemon owner + PR-3 GUI owner). Surfaced while completing PR-2.

PR-2 (agent-reviewer + `pr_review_reports` + `runAgentReview`) is **landed and green**
(342/342 pr-host tests). But two integration gaps mean the agent-review gate is currently a
**silent no-op in the live loop**. Neither is fixable purely inside PR-2 — they touch PR-1's
daemon. Recording here for consensus rather than editing PR-1's file unilaterally.

## Gap 1 — the `pr:review` trigger is inert (reviewer never runs)

`poll-daemon.ts` triggers the reviewer via `resolveLaunchTargetForEvent(PR_REVIEW_EVENT='pr:review')`
and, if a target exists, POSTs `extra: ['--pr-review', json]` to it (`defaultTriggerReviewer`,
~L617). Today:
- **No blueprint declares `pr:review`** → `resolveLaunchTargetForEvent` returns null → the
  trigger returns early (L626, "inert until PR-2 lands"). PR-2 has landed, but nothing yet
  declares the blueprint.
- **Nothing consumes `--pr-review`** → even if a target existed, no handler parses the payload
  and calls the reviewer.

Net: `runAgentReview` is never invoked by the live system, `pr_review_reports` stays empty, and
the report-veto at `poll-daemon.ts` L354–358 always reads `null` ⇒ "no veto" ⇒ auto-approve
proceeds **with no agent review**.

### What PR-2 has already built for this (ready to wire)
`runPrReviewTask(payload, ctx)` — `pr-host/agent-reviewer.ts`, exported from `pr-host/index.ts`.
Takes the exact `{remote, number, head_sha?, url?}` payload PR-1 ships, resolves a host, fetches
the PR, and runs the full review→store→audit flow. Self-contained, injectable, unit-tested
(no live host/model/DB). Whatever wiring we pick calls this.

### Options to make it live (pick one — needs consensus)
- **A. Blueprint-Bee** (matches the brief's "Queen/Bee task"): declare a `pr:review` launch
  blueprint whose spawned task parses `--pr-review` and calls `runPrReviewTask`. Heavyweight
  (a full agent session per PR), but lets a hive use a richer agent reviewer.
- **B. In-process fallback** (recommended default): when no blueprint target exists, have
  `defaultTriggerReviewer` call `runPrReviewTask(...)` fire-and-forget. Cheap, already built,
  runs the deterministic + safety-guarded path. Keep A as an opt-in override.
- **C. Loopback endpoint**: `POST /api/harness/:slug/prs/:number/agent-review` → `runPrReviewTask`;
  blueprint target = that URL. Useful if PR-3's GUI also wants a manual "re-review" button.

**PR-2's recommendation:** B as the default (zero new infra, uses the guarded path), with A
available for hives that opt into a full-agent reviewer. Owner of the change: PR-1 daemon author
(it's their `defaultTriggerReviewer`); PR-2's `runPrReviewTask` is the callee, done.

## Gap 2 — first-sight race bypasses the gate even once Gap 1 is fixed

The review trigger is fire-and-forget (both the blueprint spawn and any in-process fallback).
On the **first poll** that sees a PR, the report isn't written yet, so the same iteration's
veto check (L354) reads `null` ⇒ "no veto" ⇒ a trusted-author + green-checks PR is
**auto-approved before the agent ever reviews it**. The agent gate only ever applies from the
*second* poll on — so on the common fast path it's bypassed.

**Proposed fix (PR-1 gate semantics):** in AUTO mode, when `pr_reviewer_role_enabled` AND
`auto_review` are on, treat an **absent report as "wait", not "no veto"** — skip auto-approve
this cycle and let the next poll (after the report lands) decide. I.e. require a present
`approve` report before auto-approving, rather than only blocking on a present non-approve.
This is a one-branch change at L354 but it's a real semantics decision (owner: PR-1 author).
Today's "absent ⇒ proceed" is the right behavior only when the reviewer role is OFF.

## Tracking
Native task filed by su-pr2. PR-2's side (the `runPrReviewTask` entry point) is complete and
green; the two items above are handoffs to the PR-1 daemon owner.
