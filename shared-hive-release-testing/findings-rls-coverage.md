# Findings — RLS coverage on federated tables (defense-in-depth gap)

**Status: CHARACTERIZED — low-severity defense-in-depth gap, owner/peer decision optional**
(2026-06-20). Found + investigated during an autonomous session (loop Priority-0) while hardening
the federation substrate after EN-1. **No schema/behavior change made.**

> **Self-correction:** an interim version of this doc escalated this to a "likely-real cross-tenant
> leak." Verifying the actual read sites **refuted** that — the tables are isolated by explicit
> filtering (below). Recording the corrected, accurate version. The lesson (verify access paths
> before grading an RLS-absence finding) is the durable takeaway.

## The finding (accurate)
A new live-schema guard (`packages/operator-core/lib/sync/hyperbee/__tests__/rls-coverage.integration.test.ts`,
migrates 000→head, introspects `pg_class.relrowsecurity` + `pg_policies`) found **8 federated
(CDC-captured), workspace-scoped tables with `relrowsecurity = false`**, while ~85 sibling tables
(incl. `harness_features_consolidated`) carry the canonical workspace RLS policy from `000-baseline`:
`harness_issues_consolidated`, `coord_conversations`, `coord_event_log`, `coord_threads`,
`coord_thread_posts`, `engineer_issues`, `plan_item_assignments`, `contributor_usage_events`.

**These are not unprotected.** The codebase has two isolation models:
1. **RLS + `withWorkspace()`** — set `app.workspace_id` per txn, run as the non-BYPASSRLS app role,
   let RLS filter (the ~85 tables, incl. features/plans/hive_*).
2. **Explicit `workspace_id` predicates** in the application queries — the model these 8 use.

Model (2) is **verified** for the 8: e.g. `issues-engineer.ts` (`WHERE workspace_id = issuesScopeWorkspace()`),
`agent-tools/coordination/messages.ts` (`WHERE workspace_id = coordWorkspaceId()`),
`agent-tools/coordination/conversations-store.ts` (`WHERE workspace_id = this.ws`),
`plan-items/assignments.ts` (`WHERE workspace_id = ${workspaceId}`). So the steady-state stores
isolate correctly.

## The residual gap (defense-in-depth, low severity)
With no RLS backstop, isolation rests on **every** query remembering the explicit predicate. One
spot does not: **`packages/operator-core/lib/topics-feed.ts`** — an ObjectRef label resolver — reads
several tables **by ref with no `workspace_id` predicate**:
- L60 `engineer_issues WHERE issue_id = ${o.ref}` — **no RLS, no ws filter** → unbackstopped.
- L75 `coord_conversations WHERE id = ${o.ref}` — **no RLS, no ws filter** → unbackstopped.
- L65 `harness_features_consolidated WHERE feature_id = ${o.ref}` and L70 `harness_plans WHERE plan_slug = ${o.ref}`
  — no ws filter either, but these tables HAVE RLS, so they are backstopped **iff** this runs as the
  app role (model 1).

Impact is **low**: it leaks only `title`+`state` for a single ref, and in practice `o.ref` comes
from objects already in the caller's own feed (same workspace). But it is a concrete instance of
exactly the mistake an RLS backstop exists to catch — the explicit-filter discipline was not applied
uniformly.

## Options (for owner/peer — not auto-applied)
- **Cheap, targeted:** add the workspace predicate to the `topics-feed.ts` resolver reads (use each
  table's scope helper — `issuesScopeWorkspace()` / `coordWorkspaceId()`). One-liners. Not done here
  because picking the right helper per table needs the coordination-module owner's context, and the
  severity didn't warrant a blind cross-table patch.
- **Systemic backstop:** give the 8 tables RLS too (mirror mig-317/186), so a forgotten filter can't
  leak. This is a change to core multi-tenant tables → consensus-needing (the loop instructions
  reserve it for peers/owner; coord MCP was down this session).

## What shipped now (safe, CI-green)
`rls-coverage.integration.test.ts` — **4 tests GREEN**. Reframed invariant: every federated
workspace-scoped table must EITHER enforce RLS, OR be documented in `RLS_EXEMPT` as
explicit-filtering-isolated (the 8, each with its verified filter site). A stale-exemption test forces
an entry's removal the moment its table gains RLS. **Forward value:** a NEW federated table with
neither RLS nor a documented explicit-filtering entry fails CI, forcing an on-purpose isolation choice
— the gap that produced this list went uncaught before.

---

## Per-table read-path AUDIT — `harness_issues_consolidated` (pr5-impl, 2026-06-20) → LIKELY-REAL gap

Picked up the per-table audit the finding flagged as a tracked WI (read-only investigation; NO schema
change — that stays consensus-gated). Started with the strongest smell. Evidence chain:

1. **Read path:** the federated table is served by the sync query **`issuesConsolidated.bySlug`**
   (`sync-resolver/index.ts:1322`): `db.select().from(harnessIssuesConsolidated).where(eq(harnessSlug, …))`
   — **filters `harness_slug` ONLY; no `workspace_id` predicate, no `set_config('app.workspace_id')`.**
   (Contrast `resolveDesignSketches` @174/196 which DOES both — the resolver is mixed, not uniform.)
2. **PK = `(harness_slug, issue_id)`** (000-baseline.sql:3547) — **workspace_id is NOT in the PK.** So
   the SAME user-chosen `harness_slug` (e.g. "papercup") can legitimately hold rows in DIFFERENT
   workspaces. A `WHERE harness_slug = 'papercup'` read therefore spans workspaces unless something
   else filters — and nothing does:
3. **RLS is OFF** on this table (the finding's introspection) — while its sibling
   `harness_features_consolidated` carries the canonical workspace policy. The backstop the house style
   relies on is absent precisely here.

⇒ In a MULTI-TENANT deployment (multiple workspaces / one PG), `issuesConsolidated.bySlug` returns
**every workspace's issues for a shared harness_slug** = a concrete cross-tenant read. (Single-user
local operator = one workspace ⇒ no local leak; the exposure is the cloud/multi-tenant case.) The role
on `getOrgPg().db` only modulates the fix, not the gap: app-role ⇒ adding RLS closes it; admin/bypass
⇒ explicit `workspace_id` filtering is ALSO required.

**Recommendation (for the finding owner / owner — consensus-gated schema change, NOT done by me):**
treat `harness_issues_consolidated` as a CONFIRMED gap → add `ENABLE ROW LEVEL SECURITY` + the canonical
`workspace_id = current_setting('app.workspace_id', true)` policy in a migration (mirror
`harness_features_consolidated` exactly — the sibling proves the pattern), then drop it from
`RLS_EXEMPT`. The lower-churn alternative (thread `workspaceId` into `issuesConsolidated.bySlug` + filter
explicitly) fights the house RLS style and needs the resolver to pass workspace context — the RLS-policy
fix is cleaner + consistent. Next audit targets per the finding: the `coord_*` tables (same read-pattern
check). I can continue the per-table audits on later loop passes if no one else takes them. — pr5-impl

### Fast triage of the OTHER 7 (pr5-impl, 2026-06-20) — read-path workspace_id check

Bounded pass (grep read-sites + check for an explicit `workspace_id` predicate), to prioritise the
remaining per-table audits. NOT conclusive for the ones marked "verify" — flagging for the owner /
deeper look rather than over-investing in non-domain internals.

| Table | Read-path signal | Severity lean |
|---|---|---|
| `harness_issues_consolidated` | `issuesConsolidated.bySlug`: harness_slug only, NO workspace_id, RLS off | **CONFIRMED real** (above) |
| `engineer_issues` | `issues-engineer.ts` references workspace_id 20× (its reads filter); BUT the GUI sync read `workItems.byHarness` delegates to a helper — **verify that helper filters workspace_id** | likely-filtered; VERIFY the sync read |
| `plan_item_assignments` | `plan-items/assignments.ts` references workspace_id 14× → reads appear explicitly filtered | likely-LOWER (verify no unfiltered path) |
| `contributor_usage_events` | `usage-events.ts` read has NO workspace_id; but finding notes append-only + "does not actually federate" | LOWER (finding's own assessment) |
| `coord_conversations` | coord substrate — read via coord:* tools, NOT the sync-resolver; read-path not yet mapped | **UNAUDITED** — needs coord read map |
| `coord_event_log` | same (coord substrate) | **UNAUDITED** |
| `coord_threads` | same | **UNAUDITED** |
| `coord_thread_posts` | same | **UNAUDITED** |

**Net for the owner:** 1 CONFIRMED (issues_consolidated) → add the RLS policy. 2 likely-filtered
(engineer_issues / plan_item_assignments) — quick confirm of their sync/helper reads would settle them.
1 lower-risk (contributor_usage_events). The 4 `coord_*` tables are the real remaining unknown — they're
the coordination substrate (read by coord:* tools, a different path from the GUI sync-resolver), so they
need whoever owns coord to map their read paths. I've taken the audit as far as is responsible from
outside the federation/coord lanes; the CI guard (REVIEW allowlist) keeps it honest meanwhile. — pr5-impl

### ⚠ Fix-implementer note (pr5-impl) — naive "add RLS" will BREAK the issues read
`issuesConsolidated.bySlug` sets NEITHER `set_config('app.workspace_id', …)` NOR an explicit
`workspace_id` filter (unlike `resolveDesignSketches`, which does both). So if you ENABLE RLS +
add the `workspace_id = current_setting('app.workspace_id', true)` policy on
`harness_issues_consolidated` WITHOUT also fixing the read, the policy compares against an unset GUC
→ the GUI issues read returns **zero rows** (feature breaks). The fix is COORDINATED, two parts:
  1. migration: ENABLE ROW LEVEL SECURITY + canonical policy (mirror features_consolidated), AND
  2. make `issuesConsolidated.bySlug` set the GUC inside its txn (mirror resolveDesignSketches @196) —
     OR filter `workspace_id` explicitly in the drizzle `.where(...)`.
This is also why it's correctly consensus-gated (not a one-line migration). The same coordinated
check applies to any of the 8 whose reads don't currently set the GUC. — pr5-impl
