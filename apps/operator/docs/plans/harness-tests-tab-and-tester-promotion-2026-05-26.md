---
title: Harness Tests tab + tester role promotion + admin/testing shell extraction
slug: harness-tests-tab-and-tester-promotion-2026-05-26
status: active
created: 2026-05-26
updated: 2026-05-30
owner: avi@storewolf.com
---

# Harness Tests tab + tester role promotion + admin/testing shell extraction

## Now

**State:** **Phase A COMPLETE.** P-001 (266b25be: registry → @papercusp/testing-shell) + P-002 (ca24cbee: DomainTestPanel + injected TestingDataSource into the lib) done earlier. P-003/P-004/P-005 done (fdb365e8): `<TestingShell>` (left-rail + panel host) extracted to the lib, parameterized by `tabs` / `tierLabels` / `dataSource` / `customTabs` — the admin 3-tier grouping generalized to an arbitrary tierId→label map (key order = render order) so the harness can use Built-in/Project tiers; added `tabsFromRegistry(TestDomain[])` for registry-shaped callers; the shell chrome CSS moved into the lib (`testing-shell.css`) so it travels with the component. Admin `TestingClient` reduced to a thin wrapper (behavior identical). Verified: lib tsc clean; operator-vite 120 errors vs 121 original (net −1, zero new); 17/17 tests pass (4 new in `apps/operator/lib/__tests__/testing-shell.test.tsx` + 13 existing registry). NOT browser-verified live in the desktop shell yet.

**Reconciliation (2026-05-30) still stands:** Phase E rewritten onto the shipped `harness_plan_assertions` (no new `validation_criteria` table); Phase G adds the plan↔test-via-VAL link (B-as-D). See D-005 / D-006.

**Next:** Phase B (P-010–P-012): split `testing-domains-registry.ts` into `generalizedRegistry` (chaos/ai/live/routes/test-runs) vs the 16 Papercusp-only domains — the prerequisite for the harness Tests tab (Phase C). Optionally first: browser-verify /admin/testing renders identically post-extraction.

## Background

The user's request had four parts:

1. Add a "Tests" top-level tab to the harness UI.
2. Make tests a precondition of feature approval; consider creating a tester role.
3. Use the same standardized test format as Papercusp's own `/admin/testing` surface; share the component (refactor if needed).
4. Split the new tab into two nav sections: generalized (any coding harness) vs harness-specific.

### What already exists (verified against the code)

**A. Phase-scoped tester + test-writer + testing-orchestrator already exist as prompt files**

- `libs/papercusp/packages/harness/prompts/testing/tester.md` — runs in the testing worktree, invoked with `VAL_ID=<VAL-###>`. Writes one black-box contract test per VAL. Output line: `TEST <T-ID> <VAL-ID> <framework> <file>`. Supported frameworks: `playwright | vitest | pytest`. Files land at `tests/e2e/<val-id>.spec.ts` (Playwright), `apps/web/src/__tests__/<val-id>.test.ts` (Vitest), `apps/api/tests/test_<val_id>.py` (pytest). Tests are registered in `.harness/tests.json` with shape `{id, summary, file, framework, coversVALs, status, lastRunTs, durationMs, phase}`.
- `libs/papercusp/packages/harness/prompts/testing/test-writer.md` — runs after basic contracts exist. Writes edge / boundary / adversarial tests, tagged `kind: 'edge'`.
- `libs/papercusp/packages/harness/prompts/testing/orchestrator.md` — single decision per loop iteration, prints one of `NEXT_TESTER <VAL>` / `NEXT_SECURITY` / `RUN_TESTS` / `GENERATE_TESTS` / `READY_FOR_PROD` / `ESCALATE <reason>`.

**B. Production deployment has ONE phase, not three** (per D-001)

- `apps/operator/app/harness/PhaseTabs.tsx`: `SINGLE_PHASE: Phase[] = ['staging']` and `PHASE_LABEL_WHEN_FLAG_OFF: { staging: 'main', testing: 'main', production: 'main' }`.
- Backend canonical phase name is `'staging'`; UI label is `'main'`.
- `testing/` and `production/` phase prompts + orchestrators exist in the codebase but are legacy. This plan does not use them.

**C. Per-feature staging flow (verified)**

`staging/orchestrator.md` routes the per-feature loop with decisions:
- `next_worker <F-ID>` — pick highest-priority `todo` / `failing` feature; worker implements.
- `next_validator <F-ID>` — feature is `validating` (worker committed); send to validator.
- `next_architect <F-ID> <reason>` — feature hit `attempts >= 3`; ask architect to diagnose.
- `convert_issues` — promote `harness_issues` open rows to F-FIX features.
- `done` / `escalate` / `feature_freeze` / `next_harness`.

`staging/validator.md` adversarially verifies each VAL claim per-feature using curl / psql / playwright (default: reject). Today: sets feature `passed` on all-VALs-pass, `failing` otherwise. **No durable test artifact.**

**D. Roles are filesystem-scraped, not allowlisted**

- `apps/operator/lib/known-roles.ts:19` walks `prompts/**/*.md` recursively, deduped, 30s TTL cache. `tester` is already a known role because `testing/tester.md` exists.
- Hardcoded `KNOWN_ROLES` const at `packages/agent-mcp/src/prompts/agent/role.ts:17-35` is a separate, narrower allowlist used by the `agent:role` MCP prompt verb. Doesn't include tester. One file change.
- **No `firesOn` map for the per-feature staging flow.** Staging routing is the orchestrator printing `NEXT_<ROLE>` lines that bash `run.sh` parses. `alwaysFireOn` on `.role.json` sidecars (`apps/operator/lib/role-registry.ts:73-87`) is for plugin-lifecycle events only.

**E. A harness `TestsTab.tsx` already exists — buried as a sub-tab of the Validation panel**

- `apps/operator/app/harness/HarnessDashboard.tsx:5107` uses `useQueryState('validationTab', parseAsStringEnum<'issues'|'report'|'tests'>(...))`. The Tests sub-tab renders at line 5154.
- `apps/operator/app/harness/TestsTab.tsx` reads `harness_shared.harness_tests` via `useSyncQuery({ queryName: 'harnessTests.byHarness' })`. Phase-filtered. Per-test Run button. Empty state references the tester agent.

**F. The admin /testing system is already a clean shared shell**

- `apps/operator/lib/testing-domains.ts` — pure-data registry types + functions. Zero React, zero Papercusp coupling.
- `apps/operator/lib/testing-domains-registry.ts` — 21 `defineTestDomain(...)` calls. 3 tiers: `quick` / `domain` / `surface`.
- `apps/operator-vite/src/components/admin/testing/DomainTestPanel.tsx` — shared shell. **Hardcodes `/api/admin/testing/*` paths** at lines 183, 196, 206, 226, 233, 238, 483.
- `apps/operator-vite/src/components/admin/TestingClient.tsx` — left-rail nav + `<DomainTestPanel domainId={tab} />`.
- Plan `admin-testing-tab-restructure-2026-05-24.md` shipped 2026-05-25.

**G. Test storage flow**

- Tester writes `.harness/tests.json` in the worktree.
- bash `run.sh` POSTs to `/api/internal/test-snapshot` after each NEXT_TESTER iteration (`apps/operator/lib/harness-fs-watcher.ts:513`).
- `/api/internal/test-snapshot` (`apps/operator/lib/endpoint-route/routes/internal/test-snapshot.ts:21`) — replace-all per-phase snapshot into `harness_shared.harness_tests`.
- Schema (`apps/operator/lib/ensure-schema.ts:816-835`): PK `(harness_slug, phase, test_id)`; `coversVALs` + `kind` live in `payload JSONB`.
- Run route: `apps/operator/lib/endpoint-route/routes/harness/tests.ts:78` `POST /api/harness/:slug/tests/:id/run`. Gated by `FLAGS.HARNESS_PHASES`. Runs playwright/vitest/pytest via `execFileSync` in the phase worktree.

**H. VALs are markdown rows today; promoted to PG by this plan (per D-002)**

- VALs live in `.harness/validation-contract.md` (markdown), authored by **expert** role (`libs/papercusp/packages/harness/prompts/expert.md:190+`).
- `harness_features.claims` is **TEXT** (`libs/papercusp/libs/db/sql/002-per-harness-template.sql:9`) — a serialized list of `VAL-###` ids. No format change in this plan.

### What "before approval, must pass a test" means (with D-001 locked)

**V2 (chosen):** tester runs per-feature between worker and validator within the single staging phase. Validator's per-feature gate becomes: "for every claim VAL where `requires_test = true`, is there a passing test in `harness_tests`?" The adversarial-probe activity from today's `staging/validator.md` splits into a separate `NEXT_PROBE` decision (still in staging) so the live curl/psql exploration isn't lost.

### Reviewer pushback retained

- `coversVALs` validation at the write boundary (the snapshot endpoint does no VAL-existence check today).
- Tester budget tier needed (no `quotas:tester` exists).
- Tier names `Built-in / Project`.
- Buried Validation TestsTab + new top-level Tests tab → one component with optional `featureFilter` prop.

### Reviewer pushback dropped (or moot)

- Phase D ("per-harness `.harness/testing-domains.ts` extension API") — speculative; defer until a second harness asks.
- `packaged`/`memory`/`llm`/`docs`/`transport` for generalized — Papercusp-specific surfaces; keep admin-only.

## Phase A — extract shell into libs/testing-shell (pure refactor, no behavior change)

- **P-001** `done` Create `libs/testing-shell/` workspace package. Move `apps/operator/lib/testing-domains.ts` types + registry functions verbatim to `libs/testing-shell/src/registry.ts`. Leave a one-line re-export shim at the old path during transition (pre-alpha, shim is short-lived).

- **P-002** `done` Move `apps/operator-vite/src/components/admin/testing/DomainTestPanel.tsx` to `libs/testing-shell/src/DomainTestPanel.tsx`. ONE behavior-preserving change: extract every `/api/admin/testing/*` fetch (lines 183, 196, 206, 226, 233, 238, 483 in the current file) into a `dataSource: TestingDataSource` prop. Default implementation hits the same admin paths.

- **P-003** `done` Move `apps/operator-vite/src/components/admin/TestingClient.tsx` to `libs/testing-shell/src/TestingShell.tsx`. Take `registry`, `tierLabels`, `dataSource` as props. The 3-tier `{quick,domain,surface}` becomes a generic `{[tierId]: label}` map. (fdb365e8 extracted to libs/testing-shell/src/TestingShell.tsx; shell chrome CSS moved to the lib)

- **P-004** `done` Re-implement `apps/operator-vite/src/components/admin/TestingClient.tsx` as a thin `<TestingShell registry={adminRegistry} tierLabels={{quick:'Quick runs', domain:'Domains', surface:'Surfaces'}} dataSource={adminDataSource}/>`. Behavior identical. (fdb365e8 admin TestingClient is now a thin <TestingShell> wrapper; behavior identical operator-vite tsc net -1, no new errors)

- **P-005** `done` Tests covering registry round-trip, dataSource injection (mock dataSource → asserts file-status chip), tier grouping with arbitrary tier ids. (fdb365e8 apps/operator/lib/__tests__/testing-shell.test.tsx — round-trip, arbitrary-tier grouping, dataSource injection chip, custom override; 4/4 pass 17/17 with registry suite)

## Phase B — split generalized vs Papercusp-only declarations

- **P-010** `todo` Split `apps/operator/lib/testing-domains-registry.ts`. Move `chaos` / `ai` / `live` / `routes` / `test-runs` declarations into `libs/testing-shell/src/registry/generalized.ts` (exports `generalizedRegistry: TestDomain[]`).

- **P-011** `todo` Keep the 16 Papercusp-only domains (`harness`, `voice`, `papercusp-su`, `backup`, `plans`, `operator`, `design`, `plugins`, `snapshots`, `mobile`, `provisioning`, `memory`, `packaged`, `llm`, `docs`, `transport`) in `apps/operator/lib/testing-domains-registry.papercusp.ts`. Admin composes `[...generalizedRegistry, ...papercuspRegistry]`. All 21 admin tabs preserved.

- **P-012** `todo` Tier mapping: `generalized.ts` emits `tier: 'generalized'`. Admin folds `generalized → quick` for its 3-tier UI. Harness reads `generalized → Built-in`.

## Phase C — wire harness Tests top-level tab

- **P-020** `todo` Add a `Tests` Tabs.Trigger in `apps/operator/app/harness/HarnessDashboard.tsx` `<Tabs.List h-tabs h-main-tabs>` (line ~4330). Slot between `summary` and `prs`. Class `h-tab--tests`, icon `ListChecks` (lucide-react), count badge `passing/total`.

- **P-021** `todo` Add render branch for `activePanel === 'tests'` mounting `<TestsHarnessTab slug={slug} phase={phase} featureFilter?={F-id} />`.

- **P-022** `todo` Implement `apps/operator/app/harness/TestsHarnessTab.tsx`. Registry: `[...generalizedRegistry, { id: 'acceptance', label: 'Acceptance', tier: 'project', sections: [{id:'all', label:'All VALs', runners:[{kind:'harness-tests'}]}] }]`. Tier labels `{generalized:'Built-in', project:'Project'}`. dataSource targets `/api/harness/<slug>/testing/*` (P-024).

- **P-023** `todo` Refactor `apps/operator/app/harness/TestsTab.tsx` (the buried sub-tab) into a thin wrapper over `<TestsHarnessTab featureFilter={…} />`. Single component, two callers.

- **P-024** `todo` Add API routes mirroring the admin surface, harness-scoped (gated by FLAGS.HARNESS_PHASES same as existing tests routes): `GET /api/harness/:slug/testing/domains`, `GET .../domain-detail?domainId=…`, `GET .../file-status?domainId=…`, `GET .../health-strip?domainId=…`, `POST .../run`. POST delegates to existing `/api/harness/:slug/tests/:id/run` for `runner.kind === 'harness-tests'`.

- **P-025** `todo` Add CSS for `.h-tab--tests` accent in `apps/operator/app/harness/harness.css` matching the existing tab style family.

- **P-026** `todo` Tests: snapshot the new top-level tab with empty registry, populated registry, and a featureFilter applied.

## Phase D — promote tester to a first-class staging role (V2)

- **P-050** `todo` Author `prompts/staging/tester.md`. Variant of legacy `testing/tester.md` scoped to the staging worktree: same file-naming conventions, same `.harness/tests.json` registration shape (output line `TEST <T-ID> <VAL-ID> <framework> <file>`), but resolves `validation-contract.md` from the staging worktree directly (no `promotion-handoff.md` indirection). Supported frameworks: `playwright | vitest | pytest`.

- **P-051** `todo` Add `NEXT_TESTER <FEATURE_ID> <VAL-ID>` decision to `libs/papercusp/packages/harness/prompts/staging/orchestrator.md`. Fires when feature status is `validating` (worker has committed) AND not every VAL in the feature's claims has a passing row in `harness_tests` (filtered by `coversVALs[]` ⊇ claim_val) AND the VAL's `requires_test = true`. Decision order: feature `validating` → for each uncovered VAL emit `next_tester` → once all covered emit `next_validator`.

- **P-052** `todo` Rewrite `staging/validator.md` for V2. Validator's primary verification becomes: run every test where `coversVALs[]` includes any of the feature's claim VALs; on all-pass set feature `passed`, on any-fail set `failing` + increment `attempts`. The adversarial probing rule ("think like a pentester") splits into a new `NEXT_PROBE` decision (sibling to NEXT_TESTER, still in staging) so the live curl/psql exploration isn't lost. Probes don't write durable tests; they remain ephemeral, and write findings to `harness_issues` exactly as today.

- **P-053** `todo` Add `'tester'` to the hardcoded `KNOWN_ROLES` const at `packages/agent-mcp/src/prompts/agent/role.ts:17-35` so the `agent:role` MCP prompt can return its persona text. (Already discoverable via `apps/operator/lib/known-roles.ts` filesystem scrape.)

- **P-054** `todo` Add `'tester'` to the artifact allowlist arrays in `packages/agent-mcp/src/tools/artifacts/{load,save,append}.ts`.

- **P-055** `todo` Add `apps/operator/prompts/tester.tools.md` mirroring the `validator.tools.md` format. Document the tester's per-VAL invocation contract.

- **P-056** `todo` Add quota tier `tester` to the rolesQuota configuration. Initial cap: match validator's perRun limits.

- **P-057** `todo` Wire `NEXT_TESTER <F-ID> <VAL-ID>` dispatch in bash `run.sh`. Same mechanism as `NEXT_WORKER` / `NEXT_VALIDATOR`: parse the line, invoke `prompts/staging/tester.md` with `FEATURE_ID` + `VAL_ID` env vars.

- **P-058** `todo` `coversVALs[]` write-time validation. `/api/internal/test-snapshot` rejects (or quarantines with `status: 'invalid_val_ref'`) any test row whose `coversVALs[]` references a VAL not present in `harness_shared.harness_plan_assertions` for this `(workspace, harness)` (per D-005 — the assertion store is the shipped `harness_plan_assertions`, NOT a new `validation_criteria` table). 404 to the caller; bash run.sh surfaces as a test-write failure.

- **P-059** `todo` Document the testing/ and production/ prompt-phase retirement as a separate sibling plan (out of scope here). This plan only stops *using* them; the actual file removal + code-path retirement is tracked separately.

## Phase E — Reconcile the VAL store onto the shipped `harness_plan_assertions` (replaces the old "new `validation_criteria` table" approach — per D-005)

> **Superseded:** The original Phase E (P-060…P-067) proposed a new `{{SCHEMA}}.validation_criteria` table backfilled from `.harness/validation-contract.md`, plus a `bin/harness-vals` CLI, a `vals:create`/`vals:update` API, and a Zero mapping. **All dropped.** `plans-central-harness-ux-2026-05-26` (shipped) already makes VALs first-class PG rows in `harness_shared.harness_plan_assertions (workspace_id, harness_slug, val_id, plan_slug, item_id, verify_text, evidence_text, status)`, authored as inline `[VAL-…]` bullets in plan items and written by `plans:promote` (`apps/operator/lib/agent-tools/coordination/tools/promote.ts:413`); `validation-contract.md` is retired (D-005 of that plan). There is no new table, no markdown backfill, and no separate VAL-write API — authoring already happens in the plan. Phase E now only adds the one column the tester gate needs.

- **P-060** `todo` Add `requires_test BOOLEAN NOT NULL DEFAULT true` to `harness_shared.harness_plan_assertions`. Edit the canonical DDL `libs/papercusp/libs/db/sql/087-harness-plan-assertions.sql` AND the `ensureHarnessPlanAssertionsTable()` mirror in `apps/operator/lib/ensure-schema.ts` (~line 2050) — keep the two in sync (both must apply cleanly to a fresh embedded-pg). Add a partial index `ON (...) WHERE NOT requires_test` if the gate query needs it.

- **P-061** `todo` Extend the inline VAL-* bullet format spec at `docs/spec/validation-assertion-format.md` with an optional `RequiresTest: false` sub-bullet (default `true` when absent). Update `plans:promote` (`promote.ts`) to parse it and populate the new column on INSERT/UPDATE of `harness_plan_assertions`. No change to `feature.claims` extraction.

- **P-062** `todo` `requires_test` UI toggle on the harness Tests tab **Project** section (per P-022): flipping it PATCHes `harness_plan_assertions.status`/`requires_test` for that `val_id`. Non-testable claims (e.g. "matches the design spec", "copy reads well") are set `false` so the tester/validator gate (P-051) skips them.

- **P-063** `todo` Live read for the Tests tab. Surface `harness_plan_assertions` rows for the active plan via the harness `testing/*` dataSource (P-024) — poll or SSE, **not** Zero (`libs/zero-harness` is on the retirement path per repo CLAUDE.md). The "Acceptance / Project" section lists each VAL with its `status` and covering tests (Phase G).

- **P-064** `todo` Tests: `requires_test` default + parse of the `RequiresTest:` sub-bullet round-trips through `plans:promote` into `harness_plan_assertions`; gate query correctly excludes `requires_test = false` VALs.

## Phase G — Link plans ↔ tests through the VAL (B-as-D — per D-006)

> The link already exists structurally on both sides — plan item → inline VAL → `harness_plan_assertions (plan_slug, item_id, val_id)`, and test → `coversVALs[]`. Nothing joins them today, and `harness_plan_assertions.status` is never updated. Phase G is the join + the status loop + the UI surface. No new linking edge: the VAL stays the sole join key (we explicitly reject a direct `test → plan-item` column and inline `[TEST-…]` bullets — see D-006).

- **P-080** `todo` Materialize plan linkage onto test rows (the "D" in B-as-D). In `/api/internal/test-snapshot` (`apps/operator/lib/endpoint-route/routes/internal/test-snapshot.ts`), resolve each test's `coversVALs[]` against `harness_plan_assertions` and stamp the matched `plan_slug` + `item_id` onto the `harness_tests` row (new columns, or fields in `payload` JSONB). The snapshot is replace-all per phase, so this recomputes on every write — no staleness window. Rows with empty/unmatched `coversVALs` get NULL plan linkage (infra tests — see P-084).

- **P-081** `todo` Close the assertion-status loop. Drive `harness_plan_assertions.status` from real test outcomes: on each run / snapshot, for every `val_id` a test covers, set `status` = `passed` (all covering tests pass), `failed` (any covering test fails), or `validating` (a covering test exists but hasn't run); `todo` stays the default when no test covers it yet. Today the column is INSERTed at `todo` by `plans:promote` and never moves. Writers: the snapshot endpoint (P-080) and the validator (P-052).

- **P-082** `todo` Rollup endpoint `GET /api/harness/:slug/plan-items-test-status?plan=:planSlug`, mirroring the existing feature-status endpoint `GET /api/harness/:slug/plan-items-status` (P-006 of plans-central; consumed by `decoratePlanItemBadges` in `plan-renderers.ts`). Joins `harness_tests` ⋈ `harness_plan_assertions` grouped by `item_id` → per-plan-item `{ valsTotal, valsRequiringTest, valsCovered, valsPassing }`. Polls every 10s while the plan is active.

- **P-083** `todo` Plans UI — per-item test-coverage badge alongside the existing feature-status badge. Extend `decoratePlanItemBadges` (`plan-renderers.ts`) to render `passing/required` (e.g. `3/4`), color-coded (green all-pass / amber partial / red any-fail / grey none). Clicking drills into the covering tests — reuse the `FeatureSlideOver` pattern (plans-central P-007) or open the Tests tab (P-020) filtered to that `item_id`.

- **P-084** `todo` No-VAL tests stay harness-level (the caveat that keeps the model honest). The generalized **Built-in** tier (lint / typecheck / smoke from `generalizedRegistry`, Phase B) has no `coversVALs`, hence no assertion and no plan-item rollup; it lives on the Tests tab Built-in section only. Ensure P-080/P-082 skip empty-`coversVALs` rows. Document the split: behavioral/**Project** tests link to plans via the VAL; infra/**Built-in** tests do not link to plans at all.

- **P-085** `todo` Tests: the `coversVALs` ⋈ `harness_plan_assertions` join + rollup grouping; status-loop transitions (`todo → validating → passed/failed`) on simulated runs; denormalized plan linkage recomputed correctly on replace-all snapshot; empty-`coversVALs` rows excluded from rollup.

## Phase F — Cutover + end-to-end (BLOCKED on Phase E + Phase G)

- **P-070** `todo` End-to-end on `papercup`: author a new small feature as one plan item carrying one inline `[VAL-…]` bullet → `plans:promote` (writes `feature.claims` + a `harness_plan_assertions` row at `status=todo`) → worker implements → tester writes a test with `coversVALs=[that VAL]` → snapshot stamps plan linkage + flips the assertion to `validating` → validator runs it → assertion `passed`, the plan item shows a passing-test badge (P-083), feature `passed`. Capture round-trip cost + duration.

- **P-071** `todo` Documentation. Add an agent insight at `apps/operator-docs/src/content/docs/agent-insights/` covering the V2 tester flow + the plan↔test-via-VAL link (the `harness_plan_assertions` join), explicitly noting that `validation_criteria` / `validation-contract.md` are NOT used (D-005).

## Decisions

### D-001 — V2 (tester runs per-feature in staging; testing/production phases legacy). See plan_revisions decision history.

### D-002 — ~~Option 1 (VALs become first-class rows in `harness_<slug>.validation_criteria`)~~ **SUPERSEDED by D-005 (2026-05-30):** no new `validation_criteria` table. VALs are already first-class PG rows in the shipped `harness_shared.harness_plan_assertions`, authored as inline plan-item bullets and written by `plans:promote`. See plan_revisions decision history.

### D-003 — Tier names: `Built-in` / `Project`.

### D-004 — `kind` taxonomy: keep `'contract' | 'edge'` on `harness_tests`. Adversarial probes (V2's `NEXT_PROBE`) stay ephemeral — they write to `harness_issues`, not `harness_tests`.

### D-005 — Reconcile onto `harness_plan_assertions`; do NOT build a new VAL store.
Date: 2026-05-30
`plans-central-harness-ux-2026-05-26` (shipped 2026-05-30, its D-005) already made VALs first-class PG rows in `harness_shared.harness_plan_assertions (workspace_id, harness_slug, val_id, plan_slug, item_id, verify_text, evidence_text, status)`, sourced from inline `[VAL-…]` bullets inside plan items via `plans:promote`, and retired `.harness/validation-contract.md`. This plan's original Phase E (a separate `{{SCHEMA}}.validation_criteria` table backfilled from the markdown, plus a `bin/harness-vals` CLI, a `vals:create`/`vals:update` API, and a Zero mapping) would have built a **third, competing VAL store** and reintroduced the parallel-document drift that plans-central just eliminated. It is dropped. Phase E now only adds the single `requires_test` column the tester gate needs. Authoring stays in the plan; the validator/tester read `harness_plan_assertions`.
Related: P-058, P-060, P-061, P-062, P-063, P-064

### D-006 — Plans link to tests indirectly through the VAL (B-as-D); the VAL is the sole join key.
Date: 2026-05-30
The plan→test link is realized as a **rollup join through the VAL**, not a new edge: a plan item declares inline `[VAL-…]` bullets → `harness_plan_assertions(plan_slug, item_id, val_id)`; a test declares `coversVALs[]`; the link is the join on `val_id`, rolled up to the plan item by `item_id`. Chosen over the alternatives: a **direct `test → plan-item` column** (rejected — second linking axis competing with the VAL, wrong grain, reintroduces drift) and **inline `[TEST-…]` bullets in plan items** (rejected — tests are generated artifacts, not authored intent; putting generated state in the source doc breaks its declarative contract). For read performance we additionally **materialize `plan_slug`/`item_id` onto each `harness_tests` row** at snapshot time (the "D"), giving 1-hop UI reads while the VAL remains canonical. Tests with no VAL (the **Built-in** tier: lint/typecheck/smoke) do not link to any plan item — only behavioral/**Project** tests do.
Related: P-080, P-081, P-082, P-083, P-084
