# The workspace-domain split (EI-295)
URL: /internal/docs/agent-insights/workspace-domain-split-ei295

Presence/activity rows stamp AGENT workspace; plan-store rows stamp DEFAULT. Readers joining both must accept both workspace IDs until axes unify.

## What

The Papercusp workspace scoping model uses two distinct domains for row identity:

* **Presence/activity rows** (e.g., `owner_activity`, `fleet_assignments`): stamp the **AGENT workspace** — the workspace where the agent is spawned (e.g., `papercusp-workspace`).
* **Plan-store rows** (e.g., `plans`, `plan_item_claims`, `plan_items`): stamp the **DEFAULT\_WORKSPACE\_ID** (`'default'`) — the workspace resolved by `resolvePlanScope`.

This split exists because agents span workspaces but claims + plans are anchored to a single default scope. It is intentional but sharp: readers that JOIN presence-domain rows with plan-store rows see double the workspace scope until the axes unify.

## The bugs (2026-06-11)

Three bugs surfaced from this split on 2026-06-11:

### Bug 1: fleet\_assignment reader dropped all claims

**What**: The `fleet_assignments` reader (`lib/fleet/assignments.ts`) was filtering for only one workspace ID. It would join `owner_activity` (agent workspace) with `plan_item_claims` (default workspace) but accept only one side, dropping claims in the other domain.

**Fixed in**: `packages/operator-core/lib/fleet/assignments.ts` — now accepts rows from both workspace IDs and unifies them in the result.

### Bug 2: claim renewal missed default-domain rows

**What**: The auto-renewal routine (`renewOwnerActivityClaims` in `lib/plan-items/claims.ts`) refreshed the `owner_activity` side (agent workspace) but did not refresh `plan_item_claims` rows in the default workspace. Claims would show stale in one domain while live in the other.

**Fixed in**: `packages/operator-core/lib/plan-items/claims.ts` — the renewal now touches both domains.

### Bug 3: shared-resolver counted contributors in the wrong domain

**What**: The `defaultSharedResolver` (`lib/plan-items/liveness.ts`) counted work contributors by querying `owner_activity`, but some contributors' claims were only live in the default-workspace `plan_item_claims` rows. The count was incomplete.

**Status**: Still unfixed, but harmless after fix #2. Once claims renew correctly in both domains, the domain mismatch no longer loses data — it just means the counter runs over only one domain instead of unifying both. A full fix would be to join both domains in the counter query.

## The rule for future agents

**Any reader JOINing presence-domain rows (like `owner_activity`, `fleet_assignments`) with plan-store rows (like `plan_item_claims`, `plans`, `plan_items`) must accept and return rows from BOTH workspace IDs until the axes are unified.**

This is not a bug in your code; it is a property of the schema. If you write a reader that touches both domains:

1. Do not filter by a single workspace ID mid-query.
2. Do not assume one domain "is the right one" — both are valid.
3. If you need a single answer, unify the results on the client side or add a migration to stamp both domains the same way.

The workspace split is tracked under [EI-295](/) and the unification plan is in [local-hive-orchestration D-013](/).

## Related

* `lib/fleet/assignments.ts` — reader that correctly handles both domains
* `lib/plan-items/claims.ts` — renewal routine that touches both domains
* `lib/plan-items/liveness.ts` — shared-resolver (partial fix candidate)
* EI-295 — the issue tracking full unification
* local-hive-orchestration D-013 — the unification roadmap
