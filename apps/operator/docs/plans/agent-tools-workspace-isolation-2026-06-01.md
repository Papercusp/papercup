---
title: Agent-tools deny-by-default workspace isolation (P-062) — harness_app + RLS rollout + tooldef-http choke point
slug: agent-tools-workspace-isolation-2026-06-01
status: draft
created: 2026-06-01
updated: 2026-06-01
owner: aviynw10@gmail.com
---

# Agent-tools deny-by-default workspace isolation (P-062) — harness_app + RLS rollout + tooldef-http choke point

## Now

**State:** **Gating audit DONE (per-window-workspace-context D-017); implementation phased + not started.** Goal (P-062): the agent-tools HTTP path (`/api/agent-tools/*`, 27+ tools) currently hands every tool the raw RLS-bypassing `getOrgPg()` (harness_admin) via `catchall.ts` HOST_EXTRAS.resolvePrincipalAndTx → no tool is workspace-isolated by default. Make tools run as **harness_app inside `withWorkspace(principal.workspaceId)` (GUC `app.workspace_id`)** so RLS isolates by default; cross-workspace tools opt out to `getOrgPg()` explicitly. The dispatch lives in the `@papercusp/tooldef-http` submodule (`handleHttpToolRequest` / `HttpToolHostExtras`). **Audit findings that make this a security ROLLOUT, not a flip:** (1) harness_app LACKS DML on ~40+ of 177 `harness_shared` tables harness_admin has → naive switch breaks the 27-tool path; (2) `harness_shared` holds **sensitive per-workspace tables** (operator_credentials/secrets/*_credentials, oauth_nonces, system_principals, token_index, mobile_*_tokens, auth_*, trusted_authors) that must NOT be granted to the app role; (3) **of 133 `harness_shared` tables with a `workspace_id` column, only 22 have RLS ENABLED — 111 do NOT**, so switching to harness_app gives UNSCOPED access (false isolation) until RLS is rolled out across the scoped set. Coupling/risk: grants + RLS + the host flip are interdependent — a wrong RLS policy silently breaks a table's reads/writes operator-wide, and flipping the host before RLS is complete = false isolation. Existing 22 RLS tables are the policy template (`USING (workspace_id = current_setting('app.workspace_id', true))`, ENABLE not FORCE; admin owner bypasses).

**Next:** Decide execution appetite for the ~111-table RLS rollout, then run phases in order (grants → RLS rollout, incremental + verified per group → tooldef-http scoping seam → host flip + opt-outs + 27-tool test). Recommend NOT one-shotting the RLS phase; verify each table group keeps admin reads working + app reads scoped before the host flip.

## Background

(Why this plan exists; what problem it addresses.)

## Phase 1 — TODO

(Use plans:add-item to populate. Each item is one line:
single id, status token, free text, optional blocked-by.)


## Phase 1 — Grants

- **P-001** `done` Grant-expansion migration: GRANT SELECT/INSERT/UPDATE/DELETE (+ sequence USAGE) to harness_app on harness_shared OPERATIONAL tables, EXCLUDING the sensitive set (operator_credentials/secrets/*_credentials, operator_marketplace_token, oauth_nonces, system_principals, token_index, mobile_pair/push_tokens, auth_audit_log, auth_rate_limit, trusted_authors) + any borderline (be conservative; a tool needing those uses the explicit admin opt-out). + ALTER DEFAULT PRIVILEGES for future tables. Additive/behavior-neutral (app unused for HTTP tools until Phase 4). Migration + verify admin path unaffected. (migration 095 submodule ba5add3 applied to dev; 132 operational tables granted, sensitive excluded)


## Phase 2 — RLS rollout (the crux)

- **P-002** `todo` Enable RLS + add the per-workspace policy (USING/WITH CHECK `workspace_id = current_setting('app.workspace_id', true)`, matching the existing 22) on the ~111 workspace_id-bearing harness_shared tables that lack it. INCREMENTAL + verified per table group — a wrong policy silently breaks a table operator-wide. Audit existing getOrgPgApp (harness_app) read sites FIRST: enabling RLS where an app read doesn't set the GUC returns 0 rows. Admin (owner) bypasses ENABLE, so the current admin path stays unaffected. Decide FORCE vs ENABLE. importance: high


## Phase 3 — Framework scoping seam

- **P-003** `todo` @papercusp/tooldef-http (libs/generic/tooldef-http): evolve HttpToolHostExtras so the host provides a scoping seam — run the tool INSIDE a host callback (e.g. runScoped(principal, fn)) instead of receiving a static `tx`. Land it behavior-neutral first: the host (catchall) keeps returning the admin handle, so no behavior change until Phase 4. Submodule commit + superproject pointer bump. (Restart consumes only @papercusp/tooldef, not tooldef-http, so no cross-repo impact.)


## Phase 4 — Activation + verification

- **P-004** `todo` Flip catchall.ts HOST_EXTRAS to run tools as harness_app inside withWorkspace(principal.workspaceId) (GUC set) by default; add an explicit opt-out for cross-workspace tools (call getOrgPg() / a `crossWorkspace: true` flag). Gate on Phases 1-2 complete (else false isolation). Test across all 27+ HTTP tools: each still works for its own workspace AND an A≠B isolation check (a tool can't read/write another workspace's rows). Only after green: consider default-on. importance: high


## Phase 1b — Revoke app's sensitive grants (security lockdown)

- **P-005** `todo` REVOKE harness_app SELECT/INSERT/UPDATE/DELETE on the sensitive set it ALREADY has (D-002): token_index, operator_credentials, operator_publish_credentials, operator_marketplace_token, operator_voice_credentials, operator_search_provider_credentials, oauth_nonces, system_principals, auth_audit_log, auth_rate_limit, mobile_pair_tokens, mobile_push_tokens. Verify each isn't read via getOrgPgApp first (auth.ts resolveBearer uses ADMIN context for token_index — safe; check provisioning.ts token_index writes + others). Migration + per-table verification. Must precede the Phase-4 host flip. importance: high

## Decisions

(Use plans:add-decision to append. Each decision is a third-level
heading with a date line and a body paragraph.)

### D-001 — D-001 — The RLS rollout (Phase 2) is the crux + the risk; phases are coupled, do NOT flip the host early
Date: 2026-06-01
From the gating audit (per-window-workspace-context D-017). The naive framing ("flip catchall to harness_app") is unsafe because:
- harness_app lacks DML on ~40+ harness_shared tables → breaks 27 tools without Phase 1.
- 111 of 133 workspace_id-bearing harness_shared tables have NO RLS → harness_app would read/write them UNSCOPED → FALSE isolation until Phase 2.
- harness_shared holds sensitive per-workspace tables (creds/secrets/tokens) that must be excluded from the app grant.

So the order MATTERS and the phases are coupled: **Phase 1 (grants) + Phase 2 (RLS) must both complete before Phase 4 (host flip)** — flipping early gives unscoped app access on the 111 un-RLS'd tables (worse than today's honest admin-bypass, because it LOOKS isolated). Phase 2 is the bulk + the danger: ~111 live tables, each needing the right policy; a wrong/missing policy silently returns 0 rows or denies — operator-wide for that table. Execute Phase 2 incrementally (table-group at a time), audit existing getOrgPgApp read sites first (RLS on a GUC-less app read → 0 rows), and verify admin-still-works + app-scoped per group. Recommendation: this is a deliberate security project, not a single PR; do not one-shot. Decide ENABLE vs FORCE RLS (admin owner bypasses ENABLE — fine for the current admin path; FORCE would also bind the owner).

### D-002 — D-002 — Phase 1 grants SHIPPED (095); + a pre-existing security finding: harness_app is already over-granted to sensitive tables
Date: 2026-06-01
**Phase 1 (P-001) DONE:** migration 095 (submodule ba5add3) grants harness_app DML on the 132 workspace-scoped operational harness_shared tables (excluding sensitive), + sequence usage. Applied to native dev PG; verified additive (admin/rolbypassrls unaffected; no RLS enabled → no read can break). Closes the ~40-table operational grant gap from D-017.

**Pre-existing finding (reshapes the plan — not caused by 095):** harness_app ALREADY has SELECT+INSERT on nearly ALL the sensitive tables — `token_index` (bearer tokens), `operator_credentials`, `operator_publish_credentials`, `operator_marketplace_token`, `operator_voice_credentials`, `operator_search_provider_credentials`, `oauth_nonces`, `system_principals`, `auth_audit_log`, `auth_rate_limit`, `mobile_pair_tokens`, `mobile_push_tokens`. Only `operator_secrets` + `trusted_authors` are denied to app. So the "least-privilege" app role is NOT least-privilege — and switching tools to harness_app would give them creds/token access. This is a current-state security gap independent of P-062.

**NEW Phase 1b (revoke):** REVOKE harness_app's grants on the sensitive set so deny-by-default actually protects them. De-risked: `auth.ts` resolveBearer reads `token_index` in ADMIN context ("needs to read across workspaces"), NOT via app — so revoking app's token_index access does NOT break bearer auth. Still verify each sensitive table isn't read via getOrgPgApp before revoking (provisioning.ts writes token_index — check its handle). Do Phase 1b before the Phase-4 host flip.

Net: Phase 1 (grant operational) done; Phase 1b (revoke sensitive) is the security lockdown; Phase 2 (RLS rollout, the crux) + Phase 3/4 follow.
