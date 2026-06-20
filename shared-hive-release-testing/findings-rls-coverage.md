# Findings — RLS coverage on federated tables ⚠️ CANDIDATE SECURITY FINDING

**Status: SURFACED, NEEDS OWNER/PEER DECISION** (2026-06-20). Found during autonomous
session reflection (loop Priority-0) while hardening the federation substrate after EN-1.
**No schema/behavior change was made** — this is a flagged question, not a fix, because it
needs consensus and a risky change to core multi-tenant tables. The coord MCP was down this
session, so peers could not be consulted; raising it here for the owner.

## The finding
Workspace isolation in `harness_shared` relies on Postgres RLS: every workspace-scoped table
should have `ENABLE ROW LEVEL SECURITY` + a policy
`USING/WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`, with the app
connecting as the non-BYPASSRLS `harness_app` role (see `apps/operator/test/rls-isolation.integration.test.ts`).

A new live-schema guard (`packages/operator-core/lib/sync/hyperbee/__tests__/rls-coverage.integration.test.ts`)
migrates 000→head and introspects `pg_class.relrowsecurity` + `pg_policies`. On first run it found
**8 federated (CDC-captured), workspace-scoped tables with `relrowsecurity = false`**, while ~85
sibling tables (incl. `harness_features_consolidated`) carry the canonical policy in `000-baseline`:

| Table | Note |
|---|---|
| `harness_issues_consolidated` | **Sibling `harness_features_consolidated` HAS the policy; issues does not.** Strongest smell. |
| `coord_conversations` | coordination substrate |
| `coord_event_log` | coordination substrate |
| `coord_threads` | coordination substrate |
| `coord_thread_posts` | coordination substrate |
| `engineer_issues` | per-engineer issue lane |
| `plan_item_assignments` | plan-item assignment lane |
| `contributor_usage_events` | append-only ledger; `workspace_id` added late (mig-301, "does not actually federate") — lower risk |

These are the highest-stakes surface for an isolation miss because they cross machines: a remote
op for workspace A lands in a table that any workspace's `harness_app` connection can read if RLS
isn't enforcing the predicate.

## What is NOT yet established (the open question)
`relrowsecurity = false` means RLS is **not enforced** — it does **not** by itself prove an
exploitable cross-tenant leak. Exploitability depends on the **access path**:
1. Are these tables read/written via the non-BYPASSRLS `harness_app` role (subject to RLS), or only
   via a BYPASSRLS admin role (RLS moot)?
2. Do those queries already filter `workspace_id` explicitly in every read path (defense without RLS)?

Answering (1)+(2) per table is the decision input. The existing `rls-isolation` test proves the
*mechanism* works but only on a synthetic `public.rls_demo` table — it never covered these.

## Decision needed (per table)
- **If reachable via `harness_app` without guaranteed explicit workspace filtering** → real gap:
  add `ENABLE ROW LEVEL SECURITY` + the canonical workspace policy in a migration (mirror mig-317/186),
  then drop the table's `REVIEW` entry from `RLS_EXEMPT`.
- **If intentionally unprotected** (admin-only access, or always-explicit filtering) → confirm,
  and replace the `REVIEW(...)` reason in `RLS_EXEMPT` with the settled rationale.

## What shipped now (safe, CI-green)
- `rls-coverage.integration.test.ts` — the guard, **4 tests GREEN**. It asserts every federated
  workspace-scoped table has RLS enabled + a workspace-isolation policy, EXCEPT a documented
  `RLS_EXEMPT` set. The 8 tables above are allow-listed **as REVIEW candidates** (honest: not
  confirmed safe) so CI is green while the owner decides — the same `REVIEW(findings-B)` pattern the
  column-completeness guard uses. A stale-exemption test forces each entry to be removed the moment
  the table gains RLS, so this can't rot.
- **Value regardless of the 8's outcome:** the guard now catches the *next* federated table that
  forgets RLS — the exact class of footgun that produced this list — which nothing in CI did before.

## Why this wasn't auto-fixed
Adding RLS to 8 core tables (coordination substrate, issues, assignments) is a consensus-needing
change to live multi-tenant schema — exactly the decision-point the autonomous-loop instructions say
to take to peers, not to make unilaterally. Peers were unreachable (coord MCP down) this session, so
it is surfaced here for the owner instead.
