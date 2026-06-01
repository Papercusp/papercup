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

**State:** **Phase 1 (grants) SHIPPED; the rest is BLOCKED on a structural DB-ownership decision (D-003).** Goal (P-062): run agent-tools HTTP tools as harness_app inside `withWorkspace` GUC so RLS isolates by default. Progress + the layered audit's conclusion:
- **Phase 1 (P-001) DONE** — migration 095 grants harness_app DML on the 132 workspace-scoped operational harness_shared tables (admin-owned), excluding sensitive. Additive/dormant/safe.
- **D-002 finding** — harness_app was pre-existingly over-granted to sensitive tables (token_index/creds/oauth/principals).
- **D-003 STRUCTURAL BLOCKER** — `harness_shared` has SPLIT OWNERSHIP: harness_admin owns 122 tables, **postgres_app (a superuser) owns 55**, including ALL the sensitive credential/auth tables + token_index. So: (1) the migration role harness_admin CANNOT revoke harness_app's access to them (Phase 1b — only postgres_app/superuser can; my 096 attempt was a verified no-op, deleted, dev restored to 095); (2) RLS can't be rolled out uniformly via harness_admin either (postgres_app bypasses RLS as superuser+owner). P-062's deny-by-default needs **ownership normalization first** (decide + execute as superuser whether harness_shared is uniformly harness_admin-owned — transfer the 55 postgres_app-owned tables), THEN grants/lockdown/RLS.

So P-062 is a deliberate DB-security-architecture project needing postgres_app/superuser access — NOT completable via harness_admin migrations alone. Phase 1 (095) is the only piece safely shippable without the ownership decision + superuser.

**Next:** Owner decision: should harness_shared be uniformly owned by harness_admin (transfer the 55 postgres_app-owned tables, as superuser)? That unblocks the sensitive-table lockdown (Phase 1b) + the RLS rollout (Phase 2). Until then, Phase 1 (095) stands; Phases 1b/2/3/4 are blocked.

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

- **P-005** `blocked` REVOKE harness_app SELECT/INSERT/UPDATE/DELETE on the sensitive set it ALREADY has (D-002): token_index, operator_credentials, operator_publish_credentials, operator_marketplace_token, operator_voice_credentials, operator_search_provider_credentials, oauth_nonces, system_principals, auth_audit_log, auth_rate_limit, mobile_pair_tokens, mobile_push_tokens. Verify each isn't read via getOrgPgApp first (auth.ts resolveBearer uses ADMIN context for token_index — safe; check provisioning.ts token_index writes + others). Migration + per-table verification. Must precede the Phase-4 host flip. importance: high (blocked by split ownership D-003: 7/8 sensitive tables are postgres_app-owned; harness_admin can't revoke — needs superuser + the ownership-normalization decision)

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

### D-003 — D-003 — STRUCTURAL BLOCKER: harness_shared has split ownership (harness_admin 122 / postgres_app 55); the lockdown + RLS model need superuser-level normalization
Date: 2026-06-01
Attempting Phase 1b (revoke harness_app's sensitive grants) surfaced the real crux. `harness_shared` tables are owned by TWO roles: **harness_admin (122 tables)** and **postgres_app — a SUPERUSER — (55 tables)**. The sensitive credential/auth tables are postgres_app-owned: operator_credentials, operator_voice/publish/marketplace/search credentials, oauth_nonces, auth_audit_log, auth_rate_limit, AND token_index.

Consequences for P-062:
1. **The migration role (harness_admin) CANNOT revoke/manage grants on postgres_app-owned tables** — only the owner (postgres_app) or a superuser can. My Phase-1b revoke migration (096) ran as harness_admin and was a NO-OP on the 7 postgres_app-owned tables (REVOKE silently affected nothing). 096 was deleted (not committed) + dev restored to the 095 state.
2. **RLS won't bind these tables for the app the way assumed.** postgres_app (superuser) bypasses RLS unconditionally; and the ownership split means the RLS rollout (Phase 2) can't be driven uniformly by harness_admin migrations either.
3. So P-062's deny-by-default needs an **ownership normalization** first — decide + execute (as postgres_app/superuser) whether harness_shared should be uniformly owned by harness_admin (transfer the 55 postgres_app-owned tables), THEN do grants + RLS + the lockdown. That's a superuser-level DB-architecture change, not a harness_admin migration.

**Net scope (confirmed across the session's layered audit):** P-062 = (a) ownership normalization [superuser] → (b) grant model [done for admin-owned operational tables: 095] + sensitive-table lockdown [needs superuser, blocked today] → (c) ~111-table RLS rollout → (d) tooldef-http seam → (e) host flip + 27-tool test. A deliberate DB-security project requiring postgres_app/superuser access for the ownership+lockdown parts; cannot be completed via harness_admin migrations alone. Phase 1 (095, operational grants) is the only safely-shippable piece without superuser + the ownership decision.

### D-004 — D-004 — HARD blocker: no superuser access at the agent's level; P-062 beyond Phase 1 needs postgres_app/superuser + the ownership decision
Date: 2026-06-01
Confirmed the access reality (2026-06-01). The dev box exposes only `DATABASE_URL=harness_admin` (no `MIGRATION_DATABASE_URL`/postgres_app/superuser DSN in apps/operator/.env.local; connecting as postgres_app needs a password the agent doesn't have). harness_admin is NOT a superuser and does NOT own the postgres_app tables.

Owner breakdown of the ~111 un-RLS'd workspace-scoped tables: **85 harness_admin-owned, 48 postgres_app-owned**. The 55 postgres_app-owned harness_shared tables are a coherent historical set (operator_*, org_*, user_*, auth_*, token_index, projects, routines, plugin_*, pending_events, *_consolidated) from a postgres_app-connected creation path.

Therefore, as harness_admin the agent CANNOT:
- transfer ownership (ownership normalization) — needs superuser;
- revoke harness_app's pre-existing grants on the postgres_app-owned sensitive tables (Phase 1b) — needs the owner/superuser (verified: the 096 REVOKE was a silent no-op);
- enable RLS / add policies on the 48 postgres_app-owned workspace-scoped tables (part of Phase 2) — needs the owner.

What IS doable as harness_admin (but deferred deliberately): RLS rollout on the 85 harness_admin-owned workspace-scoped tables. NOT done because (1) it's a large risky change on live tables for no realized isolation benefit until the Phase-4 host flip, and (2) the host flip is gated on ALL scoped tables (incl. the 48 postgres_app ones) being RLS'd — which needs superuser. So a partial 85-table rollout delivers nothing alone + leaves a half-state.

**Conclusion:** P-062 beyond Phase 1 (095) is HARD-BLOCKED on (a) superuser/postgres_app DB access + (b) the owner's ownership-normalization decision. Not completable by the agent at its current access level. To proceed: provide a superuser DSN + decide ownership normalization; then grants/lockdown/RLS/framework/flip can be executed.
