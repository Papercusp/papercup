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

**State:** Phase A in progress. P-001 DONE (266b25be): registry → @papercusp/testing-shell, shim, 13/13 tests. P-002 DONE (ca24cbee): DomainTestPanel + domain-panel.css moved into the lib; backend access now via injected TestingDataSource (interface + wire types + default adminTestingDataSource in data-source.ts); TestingClient passes adminTestingDataSource — behavior preserved. Verified: lib tsc exits 0; 13/13 testing-domains tests pass; new import resolves under operator-vite tsc (117 baseline errors are pre-existing @-alias/JSX-namespace, none mention testing-shell); HEAD tree confirms all files incl. css committed at new paths, old paths removed; no dangling refs. NOT yet checked: live /admin/testing page render in a browser. Also committed ca24's prerequisite: 2dc54b4b recovered the prior session's uncommitted DomainTestPanel run-drawer/history work to give P-002 a clean base.

**Next:** P-003: extract TestingClient → TestingShell in the lib (registry + tierLabels + dataSource props), then P-004 (operator-vite TestingClient becomes a thin wrapper) + P-005 (tests). Optional first: browser-verify /admin/testing still renders identically post-P-002.

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

## Decisions

(see resolved D-001, D-002 below in this plan's persisted decisions; Open decisions section retired)

## Phase A — extract shell into libs/testing-shell (pure refactor, no behavior change)

P-001 todo Create `libs/testing-shell/` workspace package. Move `apps/operator/lib/testing-domains.ts` types + registry functions verbatim to `libs/testing-shell/src/registry.ts`. Leave a one-line re-export shim at the old path during transition (pre-alpha, shim is short-lived).

P-002 todo Move `apps/operator-vite/src/components/admin/testing/DomainTestPanel.tsx` to `libs/testing-shell/src/DomainTestPanel.tsx`. ONE behavior-preserving change: extract every `/api/admin/testing/*` fetch (lines 183, 196, 206, 226, 233, 238, 483 in the current file) into a `dataSource: TestingDataSource` prop. Default implementation hits the same admin paths.

P-003 todo Move `apps/operator-vite/src/components/admin/TestingClient.tsx` to `libs/testing-shell/src/TestingShell.tsx`. Take `registry`, `tierLabels`, `dataSource` as props. The 3-tier `{quick,domain,surface}` becomes a generic `{[tierId]: label}` map.

P-004 todo Re-implement `apps/operator-vite/src/components/admin/TestingClient.tsx` as a thin `<TestingShell registry={adminRegistry} tierLabels={{quick:'Quick runs', domain:'Domains', surface:'Surfaces'}} dataSource={adminDataSource}/>`. Behavior identical.

P-005 todo Tests covering registry round-trip, dataSource injection (mock dataSource → asserts file-status chip), tier grouping with arbitrary tier ids.

## Phase B — split generalized vs Papercusp-only declarations

P-010 todo Split `apps/operator/lib/testing-domains-registry.ts`. Move `chaos` / `ai` / `live` / `routes` / `test-runs` declarations into `libs/testing-shell/src/registry/generalized.ts` (exports `generalizedRegistry: TestDomain[]`).

P-011 todo Keep the 16 Papercusp-only domains (`harness`, `voice`, `papercusp-su`, `backup`, `plans`, `operator`, `design`, `plugins`, `snapshots`, `mobile`, `provisioning`, `memory`, `packaged`, `llm`, `docs`, `transport`) in `apps/operator/lib/testing-domains-registry.papercusp.ts`. Admin composes `[...generalizedRegistry, ...papercuspRegistry]`. All 21 admin tabs preserved.

P-012 todo Tier mapping: `generalized.ts` emits `tier: 'generalized'`. Admin folds `generalized → quick` for its 3-tier UI. Harness reads `generalized → Built-in`.

## Phase C — wire harness Tests top-level tab

P-020 todo Add a `Tests` Tabs.Trigger in `apps/operator/app/harness/HarnessDashboard.tsx` `<Tabs.List h-tabs h-main-tabs>` (line ~4330). Slot between `summary` and `prs`. Class `h-tab--tests`, icon `ListChecks` (lucide-react), count badge `passing/total`.

P-021 todo Add render branch for `activePanel === 'tests'` mounting `<TestsHarnessTab slug={slug} phase={phase} featureFilter?={F-id} />`.

P-022 todo Implement `apps/operator/app/harness/TestsHarnessTab.tsx`. Registry: `[...generalizedRegistry, { id: 'acceptance', label: 'Acceptance', tier: 'project', sections: [{id:'all', label:'All VALs', runners:[{kind:'harness-tests'}]}] }]`. Tier labels `{generalized:'Built-in', project:'Project'}`. dataSource targets `/api/harness/<slug>/testing/*` (P-024).

P-023 todo Refactor `apps/operator/app/harness/TestsTab.tsx` (the buried sub-tab) into a thin wrapper over `<TestsHarnessTab featureFilter={…} />`. Single component, two callers.

P-024 todo Add API routes mirroring the admin surface, harness-scoped (gated by FLAGS.HARNESS_PHASES same as existing tests routes): `GET /api/harness/:slug/testing/domains`, `GET .../domain-detail?domainId=…`, `GET .../file-status?domainId=…`, `GET .../health-strip?domainId=…`, `POST .../run`. POST delegates to existing `/api/harness/:slug/tests/:id/run` for `runner.kind === 'harness-tests'`.

P-025 todo Add CSS for `.h-tab--tests` accent in `apps/operator/app/harness/harness.css` matching the existing tab style family.

P-026 todo Tests: snapshot the new top-level tab with empty registry, populated registry, and a featureFilter applied.

## Phase D — promote tester to a first-class staging role (V2)

P-050 todo Author `prompts/staging/tester.md`. Variant of legacy `testing/tester.md` scoped to the staging worktree: same file-naming conventions, same `.harness/tests.json` registration shape (output line `TEST <T-ID> <VAL-ID> <framework> <file>`), but resolves `validation-contract.md` from the staging worktree directly (no `promotion-handoff.md` indirection). Supported frameworks: `playwright | vitest | pytest`.

P-051 todo Add `NEXT_TESTER <FEATURE_ID> <VAL-ID>` decision to `libs/papercusp/packages/harness/prompts/staging/orchestrator.md`. Fires when feature status is `validating` (worker has committed) AND not every VAL in the feature's claims has a passing row in `harness_tests` (filtered by `coversVALs[]` ⊇ claim_val) AND the VAL's `requires_test = true`. Decision order: feature `validating` → for each uncovered VAL emit `next_tester` → once all covered emit `next_validator`.

P-052 todo Rewrite `staging/validator.md` for V2. Validator's primary verification becomes: run every test where `coversVALs[]` includes any of the feature's claim VALs; on all-pass set feature `passed`, on any-fail set `failing` + increment `attempts`. The adversarial probing rule ("think like a pentester") splits into a new `NEXT_PROBE` decision (sibling to NEXT_TESTER, still in staging) so the live curl/psql exploration isn't lost. Probes don't write durable tests; they remain ephemeral, and write findings to `harness_issues` exactly as today.

P-053 todo Add `'tester'` to the hardcoded `KNOWN_ROLES` const at `packages/agent-mcp/src/prompts/agent/role.ts:17-35` so the `agent:role` MCP prompt can return its persona text. (Already discoverable via `apps/operator/lib/known-roles.ts` filesystem scrape.)

P-054 todo Add `'tester'` to the artifact allowlist arrays in `packages/agent-mcp/src/tools/artifacts/{load,save,append}.ts`.

P-055 todo Add `apps/operator/prompts/tester.tools.md` mirroring the `validator.tools.md` format. Document the tester's per-VAL invocation contract.

P-056 todo Add quota tier `tester` to the rolesQuota configuration. Initial cap: match validator's perRun limits.

P-057 todo Wire `NEXT_TESTER <F-ID> <VAL-ID>` dispatch in bash `run.sh`. Same mechanism as `NEXT_WORKER` / `NEXT_VALIDATOR`: parse the line, invoke `prompts/staging/tester.md` with `FEATURE_ID` + `VAL_ID` env vars.

P-058 todo `coversVALs[]` write-time validation. `/api/internal/test-snapshot` rejects (or quarantines with `status: 'invalid_val_ref'`) any test row whose `coversVALs[]` references a VAL not present in `harness_<slug>.validation_criteria` (per D-002). 404 to the caller; bash run.sh surfaces as a test-write failure.

P-059 todo Document the testing/ and production/ prompt-phase retirement as a separate sibling plan (out of scope here). This plan only stops *using* them; the actual file removal + code-path retirement is tracked separately.

## Phase E — VALs become first-class PG rows (per D-002, Option 1)

P-060 todo Schema migration. Add to `libs/papercusp/libs/db/sql/002-per-harness-template.sql`:

```sql
CREATE TABLE {{SCHEMA}}.validation_criteria (
  val_id            TEXT PRIMARY KEY,
  namespace         TEXT NOT NULL,
  claim             TEXT NOT NULL,
  how_to_verify     TEXT,
  expected_evidence TEXT,
  requires_test     BOOLEAN NOT NULL DEFAULT true,
  source            TEXT,                       -- 'expert' | 'scoper' | 'human' | 'backfill'
  created_ts        BIGINT NOT NULL,
  updated_ts        BIGINT NOT NULL
);
CREATE INDEX vc_namespace_idx ON {{SCHEMA}}.validation_criteria(namespace);
CREATE INDEX vc_requires_test_idx ON {{SCHEMA}}.validation_criteria(requires_test) WHERE NOT requires_test;
```

P-061 todo Migration for installed harnesses. Add `bin/migrate-installed-harnesses-add-validation-criteria.sh` (matches the existing `migrate-installed-harnesses-add-*.sh` pattern in the codebase per the comment in `ensure-schema.ts`).

P-062 todo VAL parser + backfill CLI. New `bin/harness-vals` (read-only CLI matching the `harness-features` CLI pattern). First subcommand: `harness-vals migrate <slug>`. Parses each harness's `.harness/validation-contract.md`:
- Walk headings `### VAL-<NS>-NNN: <claim>`.
- Body captures `**Verify:** …` and `**Evidence:** …` sections.
- Insert rows with `source='backfill'`. Failed parses still insert (with NULL `how_to_verify`/`expected_evidence`) so existing features that reference these VALs still gate properly; architect refines on next touch.
- Idempotent: ON CONFLICT (val_id) DO NOTHING.

P-063 todo Write API + tool. New endpoint `POST /api/harness/:slug/vals` (and matching MCP tool `vals:create` / `vals:update`) for architect/expert/scoper to write VALs. ID allocation inside a per-namespace lock — same idiom as `plans:add-decision` D-NNN. Updates set `updated_ts` and respect `requires_test`.

P-064 todo Update `expert.md` + `scoper.md` + `architect.md` prompts to write VALs via the new API instead of (or in addition to) editing `.harness/validation-contract.md`. Markdown becomes a generated read-only view: a file-watcher (or on-demand renderer) emits `validation-contract.md` from `validation_criteria` rows. Pre-existing markdown stays read-only; new writes go through the table.

P-065 todo `requires_test` defaults to `true`. Expert/architect explicitly set `false` for non-testable claims at write time. UI surface for toggling lives on the harness Tests tab Project section (per P-022).

P-066 todo Zero schema mapping. Add `validation_criteria` to `libs/zero-harness/src/schema.ts` so the Tests tab can subscribe via `useSyncQuery` rather than poll. Mirror the harness_tests pattern.

P-067 todo Tests: VAL parser round-trip, ID allocation under contention, requires_test default, Zero sync.

## Phase F — backfill + cutover (BLOCKED on Phase E)

P-070 todo Run `harness-vals migrate <slug>` against `papercup` (the only registered harness). Confirm row count matches `.harness/validation-contract.md` heading count.

P-071 todo End-to-end: scope a small new feature with one claim VAL → architect commits plan → worker implements → tester writes test → validator runs test → feature `passed`. Capture round-trip cost + duration.

P-072 todo Documentation. Update agent insights at `apps/operator-docs/src/content/docs/agent-insights/` with the V2 flow + the `validation_criteria` table.

## Resolved decisions

D-001 — V2 (tester runs per-feature in staging; testing/production phases legacy). See plan_revisions decision history.

D-002 — Option 1 (VALs become first-class rows in `harness_<slug>.validation_criteria`). See plan_revisions decision history.

D-003 — Tier names: `Built-in` / `Project`.

D-004 — `kind` taxonomy: keep `'contract' | 'edge'` on `harness_tests`. Adversarial probes (V2's `NEXT_PROBE`) stay ephemeral — they write to `harness_issues`, not `harness_tests`.
