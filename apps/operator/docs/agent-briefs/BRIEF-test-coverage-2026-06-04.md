# BRIEF — Test coverage for the session's shipped + in-flight work

**Owner:** aviynw@gmail.com · **Created:** 2026-06-04 · **For:** a lead test agent (who should fan out sub-agents per domain)

## Goal
A large body of work shipped or is in flight this session. Bring it under solid test coverage — **organized correctly**. The naive approach ("one agent per plan") is **wrong** and will collide + duplicate + miss the real bugs. Follow the strategy below.

## The strategy (read this first)

**Do NOT write one test agent per plan.** The work is at three maturity tiers, and tests map differently to each:

1. **Shipped** (already built+tested by their agents): coordination-substrate, release-gate (su-f7aab), revive-plugin-system (su-06511 — incl. migration 137 `plugin_audit_log`, `ui:tui-pane`, gitnexus/ctx.secret), handoff-dx §A, tui-workbench P12 (su-a6146 — migration 138 `tui_*` tables + `/api/tui/*`). → **Coverage AUDIT + gap-fill**, not blanket re-testing.
2. **In-flight** (an active agent owns the tests): revive-cupboard-distribution (su-074be3de — *already adding* the `install-plugin-core` path-traversal tests). → **Tests ship WITH their build. COORDINATE; do NOT touch their files** (lock-collision + duplicate work).
3. **Unbuilt** (design only — no code): unify-work-items, event-reaction-system, rules-engine, the curator/operator/pui cluster, self-improvement loop, etc. → **Do NOT pre-write tests.** Tests come with the build (their plan phases already say so).

**Organize by test DOMAIN, not by plan.** The plans share substrate (coordination substrate, work_items, endpoint system) — per-plan agents would each touch the same shared tests and collide. The project already groups tests by domain in `apps/operator/lib/testing-domains-registry.ts` (carve note: backend may now be `packages/operator-core/lib/`) + the `/admin/testing` tabs. Use that grouping.

**The bugs are in the SEAMS.** Per-plan testing structurally misses cross-plan integration. Budget a dedicated integration pass (see Step 3).

## Steps

### Step 0 — Get to green first
`su-adfa2834` flagged: operator-core's test task is **RED on main** — several "exactly N" count/registry tests broke from concurrent same-day additions (new tools/domains/tables). **Fix those count assertions to a green baseline before adding new tests** (you can't measure coverage against red). Find them via the failing `npm run test:all:integration` / the operator-core count tests; update each `toHaveLength(N)` / `toBe(N)` to the current reality. (Verified: `plans:edit` is NOT a culprit — already registered + tools-md-sync-covered.)

### Step 1 — Coverage AUDIT (read-only, fan out by domain)
Spawn read-only sub-agents, one per domain, to produce a **targeted gap list**: which shipped code paths are untested, and which cross-plan seams lack integration tests. **Don't write blind** — auditing first avoids re-testing covered code and wasting effort on unbuilt code. Output: a per-domain list of `{file, untested-path, suggested-test, canonical-home}`.

### Step 2 — Write tests per DOMAIN (fan out, clear file-ownership)
For each domain, a sub-agent writes the gap-fill tests into the **four canonical homes** (Vitest unit / Playwright e2e / Cargo / LLM scenarios — see `/internal/docs/testing`). Give each sub-agent a **disjoint file set** so locks don't collide; **lock files before editing**; **skip files owned by in-flight agents** (coord-check first). Domains to cover:
- **coordination substrate** — topics, conversations, issues, fanout/subscribe→inject, presence/liveness
- **plans / work_items** — plans-pg, the plan tools (incl. `plans:edit`)
- **release-gate** — green-checkpoint → ready → deploy chokepoint + the release-manager judgment (shipped — verify the 25 tests + gaps)
- **plugin-host + revive-plugin-system** — loader, capability/sandbox, the `plugin_audit_log` fail-closed on a non-superuser PG role, `ui:tui-pane`
- **cupboard / distribution** — COORDINATE with su-074be3de; focus on what they haven't covered (publish/fork round-trips), leave install-plugin-core traversal to them
- **tui-workbench / pui** — the `/api/tui/*` routes + persistence (su-a6146 P12); for any UI e2e use an **own Xvfb-driven instance** (never the user's live `:0` Tauri)
- **cross-CLI launch** — the claude/codex/omp adapters (`role-launch-spec`, `role-codex-home`, `ensure-omp-su`, the `hooks/cc` shared-shell contract)

### Step 3 — Cross-plan integration pass (the high-value part)
Integration tests for the seams the per-domain tests miss:
- coordination substrate ↔ work_items ↔ federation (subscribe→inject end-to-end across two peers)
- cupboard: publish → fork/install round-trip incl. the **untrusted-manifest hardening** (a malicious `manifest.name`/`listingRef` is rejected + writes nothing outside global-plugins)
- release-gate: a deliberately-bad candidate is held at the green-checkpoint; a good one promotes ready → deploy
- cross-CLI: the same MCP + hook contract behaves identically on claude vs codex (note: codex PreToolUse doesn't fire on edits in 0.135/6 — lock enforcement is voluntary there)

## Rules / gotchas
- Use the project's framework + canonical homes (read `/internal/docs/testing` + `/internal/docs/testing/agent-e2e`). **No ad-hoc test scripts.** A passing typecheck is not a test.
- Run `npm run test:affected`; new tests must be picked up by `npm run lint:tests` (the coverage guard) — widen a domain glob + `npm run gen:contract` if it fires for a new area.
- **`test:affected` may be polluted by concurrent peers** — judge "green" from a clean checkout of the candidate, not the shared churning tree.
- Plans are **PG-canonical** — read them with `plans:get` / `plans:list { harness:'all' }`, not from disk.
- The backend was carved to `packages/operator-core/lib/**`; a `.harness/`→`.papercusp/` rename also landed — don't trust stale paths.
- **Coordinate continuously** — re-check `coord:presence` / `coord:inbox` before touching any file; this is a busy shared tree.

## Deliverable
(1) The RED count tests fixed → green baseline. (2) The per-domain coverage gap list. (3) New tests filling the gaps, green, registry-discovered. (4) The cross-plan integration suite for the seams. (5) A short coverage summary per domain.
