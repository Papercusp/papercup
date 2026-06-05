# Test-coverage pass — summary (BRIEF-test-coverage-2026-06-04)

**Lead:** su-5cf8c · **Date:** 2026-06-04 · Deliverable #5 of the parent brief.

Coverage was added **by domain** (not per-plan), on **settled** surfaces only, steering clear of the in-flight rebuilds (unify-work-items, federation, tui, voice, the generalize-libs carve). **~196 new test cases across 33 new files**, all green and registry-discovered (`lint:tests` + `gen:contract:check` pass). Two fan-out rounds: round 1 took the highest-value gap per domain; **round 2** (7 files, 36 cases) filled the remaining medium-value gaps on the two surfaces that stayed stable+unowned through the night — plans document-tools (replace_all idempotency, version-before-hash CAS precedence, terminal-status side-effect, plansDrafts null-date sort tie-break) and the cross-CLI launch path (bearer-non-transit D-006, the claude native-session-id mint→force→resume round-trip, launch-su kickoff/model/resume passthrough). No product bugs in either round 2 surface.

## Step 0 — green baseline (DONE)
operator-core's unit suite was RED from concurrent same-day additions. Fixed and re-verified green across all shards (~7,000 tests):
- **Count/registry drift → robust:** `testing-domains-registry.test.ts`, `sync-resolver/table-to-query-names.test.ts`, `sync-resolver/index.test.ts` (the `readAllPlans` PG-canonical mock rewrite). Brittle "exactly N" asserts replaced with `≥N + membership + no-duplicate` so they stop re-flapping under concurrent domain/tool additions.
- **Carve-stale reds I also found + fixed:** `finding-context-sync.test.ts` (grepped the pre-carve `apps/operator/lib/agent-tools` path → converted the defeated "warn-only" into a real drift assertion), `ipc-allowlist.test.ts` (same stale path), `tool-auth-gating.test.ts` + `power-user-routes.test.ts`.
- **Real tagging bug fixed:** the entire `issues:*` family (13 tools) was missing `profile:'engineer'`, leaking the engineer issue-tracker into the power-user end-user profile. Tagged the family.

## Per-domain coverage

| Domain | Verdict before | What was filled (new files) | Notes |
|---|---|---|---|
| **release-gate** | mechanics covered, gate-decision layer untested | health-probe, verify-release-paths, deploy-gate (gatherPlan non-FF/forced + refusal predicate + `release-manager ∈ AGENT_ROLES`), deploy-rollback-edges, release-actions (system-action registration + release-trigger noop-gating) — **18 cases** | Gate's exit-2 CLI chokepoint + release-manager model-pin → **Brief: release-gate** (EI-7) |
| **plugin-host / revive-plugin** | logic covered, fail-closed seams untested | **real `PgAuditWriter` D-001 fail-closed gate as `harness_app`** (the one path that ships, vs the old hand-copied INSERT), discovery-clamp boundaries, tui_panes handler, secret-resolver PG-outage fallback, grants fork/backfill — **34 cases** | EI-3 (live host discovers 0 plugins) not reproducible in a hermetic test |
| **plans (document tools)** | pure cores covered, handler/PG-read paths untested | edit-handler (revision-on-write / no-revision-on-reject / would_orphan / string_not_unique hint), source-scope (resolvePlanScope branches), source-archived (archived filter + cross-workspace isolation), set-content-chunk state machine — **25 cases** | EI-6 (envelope-key inconsistency) **fixed + resolved** |
| **cross-CLI launch** | per-CLI matrices exist, identity seam untested | launch-agent fallback ordering, ensure-omp-su single-flight cache, bootstrap-su features branch; **role-sid-binding.todo** documents the bug — **21 cases + todo** | **Confirmed bug EI-4**: role path never binds PAPERCUSP_SID into MCP client/codex-home (lock-hook owner ≠ MCP-call owner). Filed, not fixed (su-584a8's resolveAgentIdentity area) |
| **cupboard / distribution** | leaf units covered, every seam untested | plugin-listings (the dep-validator's only live source, was 0 tests) + round-trip into validateBlueprintDependencies, listing-action/isListingKind, publish-hardening, operator-core snapshot-index, **publish→fork content-addressing round-trip** (tarball_content_hash contract, msw worker) — **42 cases** | install-traversal left to su-074be (their lane); no defects found |
| **coordination (federation-independent cores)** | lifecycle cores partly covered | answer-capture (no test before), ask-knowledge-tier byRef dedup + sort, conversations resolve-by-bad-post-id + reparent no-op — **20 cases** | The federation-area seams (coord-inbox-bus producer #1, fanout, presence-sweep) → **Brief: coordination-federation-area** (su-584a8) |
| **tui-workbench / pui** | store covered, route layer untested | (deferred — su-a6146 owned it during the pass) | → **Brief: tui-routes** (now settled) |

## Cross-plan seams (Step 3)
Covered via the integration tests above: the cupboard **publish→fork content-addressing round-trip**, the release **gate refusal + system-action wiring**, the plugin **fail-closed real-writer as the least-privilege role**. The marquee **two-peer subscribe→inject federation seam** was deferred (federation + work_items were mid-rebuild) → **Brief: workitems-and-crossplan-seam** (Part B, hold until su-584a8 Track A lands).

## Infrastructure fix (bonus)
The SP1 carve moved several plans/cross_harness integration tests into operator-core but left the `baselineSchemaDsn` globalSetup in apps/operator, leaving 3 integration tests carve-broken (`e2e`, `concurrency`, `cross_harness/plans` — "Invalid URL"). Lifted the globalSetup into shared `@papercusp/test-config` (`BASELINE_SCHEMA_GLOBAL_SETUP_PATH`, robust repo-root walk) and wired both integration configs. The 3 now pass; apps/operator's suite unaffected.

## Filed issues
- **EI-4** (major, open) — role-launch PAPERCUSP_SID binding bug (cross-CLI).
- **EI-6** (minor, **resolved**) — set-content-chunk failure-envelope normalized to canonical `error`.
- **EI-7** (major, open) — release-manager has no in-tree model pin / persona.

## Follow-up briefs (handed off)
`BRIEF-test-coverage-fu-tui-routes.md` (ready; note tui is now hot — su-3854d/cdf6b/f49a5) · `BRIEF-test-coverage-fu-release-gate.md` (ready) · `BRIEF-test-coverage-fu-coordination-federation-area.md` (coordinate w/ su-584a8) · `BRIEF-test-coverage-fu-workitems-and-crossplan-seam.md` (Part A picked up by su-d6be1d64 / Part B blocked) · `BRIEF-test-coverage-fu-pui-live-e2e.md` (the one structural TUI gap — rendered-terminal e2e via tui:dispatch + own-Xvfb; coordinate/wait, tui hot).

## Remaining gaps NOT covered + why (nothing silently dropped)
- **cupboard** resolve-repo-coords edges / github_url fallback — became in-flight (su-c8ca5 cupboard hardening); deferred to a calmer window.
- **plugin-host** ctx.secret per-request route wiring (catchall/_mcp-handler) — low-ROI in isolation; noted.
- **cross-CLI** `_mcp-handler` owner precedence (#11) + the **EI-4 SID fix** — sit in su-584a8's `resolveAgentIdentity`/authority area; left to that owner; the contract is documented in `role-sid-binding.todo.test.ts`.
- **coordination federation-area** + **work_items lifecycle** + **two-peer federation seam** + **tui routes/live-e2e** — all owned by the 5 follow-up briefs above.

**Optional low-priority cleanup (no brief):** convert the 3 plans integration tests from their own per-file container to the now-wired shared `inject('baselineSchemaDsn')` fixture (removes ~17s of redundant container startup; they pass as-is).
