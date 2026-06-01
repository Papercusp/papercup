---
title: Generalize the testing framework + UI into a cross-project shared lib
slug: testing-shell-cross-project-2026-06-01
status: draft
created: 2026-06-01
updated: 2026-06-01
owner: aviynw3@gmail.com
---

# Generalize the testing framework + UI into a cross-project shared lib

## Now

**State:** M1/Phase 0 DONE (commit cbe0addf7): @papercusp/testing-shell extracted to github.com/Papercusp/testing-shell (private) and re-added as an in-place submodule at libs/testing-shell; cataloged under BORROWABLE 'Testing & QA'; generator crash fixed. Verified live (harness endpoint 22 domains + {universal,project}, lib tests 14/14, symlink resolves). This sits on the completed lib foundation + Phase 1 portable-universal-tier work. User authorized the full remaining campaign (Phase 0✓, Phase 3 Restart, Phase 2 UI via Tauri, generalize chaos/ai/live, /tester shared tab, glob-walker, Phase 4 test-config). Now starting M2: Restart adopts testing-shell.

**Next:** M2 (Phase 3): add @papercusp/testing-shell as a submodule in /home/marsh-office/Restart, add nuqs NuqsAdapter, implement Restart's TestingDataSource, convert app/tests to render TestingShell, wire k6 as the consumer + test in Restart.

## Background

The `/adv` harness Tests tab and `/admin/testing` are two faces of one shell. During `harness-tests-tab-and-tester-promotion-2026-05-26` (P-002/P-003) the panel was extracted into `@papercusp/testing-shell` with the backend behind a `TestingDataSource` interface, precisely so the same React component could drive multiple backends. Today:

- `/admin/testing` injects `adminTestingDataSource` → `/api/admin/testing/*`.
- `/adv` harness Tests tab injects `makeHarnessTestingDataSource(slug, phase)` → `/api/harness/:slug/testing/*`, and reads its domain nav from the per-harness contract `<worktree>/.harness/testing-domains.json`.

So "one UI, two adapters" already works. Restart would be the third adapter.

**What is generic (in `libs/testing-shell/`, zero Papercusp coupling, `sideEffects:false`):** `TestingShell.tsx` (rail + panel host, props `tabs`/`tierLabels`/`dataSource`/`customTabs`), `DomainTestPanel.tsx`, `data-source.ts` (the `TestingDataSource` interface + wire types + default `adminTestingDataSource`), `registry.ts` + `registry/generalized.ts` (`defineTestDomain`, the `TestDomain`/`TestRunner` model). The shell **never keys off file extension or path** — `TestRunner` is an explicit tagged union — so it is convention-agnostic by construction.

**What is Papercusp-coupled (all operator-side, none in the shell):**
- `apps/operator/lib/testing-domains-registry.ts` — domain defs with hardcoded `apps/operator/**` globs.
- `apps/operator/lib/endpoint-route/routes/harness/testing.ts` — depends on the harness resolver, the staging/testing/production phase-worktree system, a hardcoded `npx vitest run` executor, and PG (`harness_shared.harness_plan_assertions` / `harness_tests`).
- `AcceptancePanel.tsx` + the 8 bespoke `/admin/testing` custom tabs (VAL assertions, chaos/AI-explore orchestrators).

**The Restart side:** `apps/web` is Next 16 App Router / React 19. `/tests` is a read-only JUnit-XML aggregator (`aggregateJUnit`), `/load-tests` is a polished k6 runner (SSE live log), `/tester` is a Monaco API explorer. It is already `?project=`-aware (`lib/projects.ts` lists `restart` + `papercusp`, the latter targeting `:3055`). It already vendors 5 `@papercusp/*` libs as **git submodules** and runs the same `scripts/affected-tests.mjs` walker + nx + Vitest 4 + a same-named `@papercusp/test-config`. So the two repos share lineage; the shell is a natural fit.

## Scope / Non-goals

**In scope:** promote `testing-shell` to a borrowable submodule; make the Universal tier project-resolved; add the k6 runner kind, the JUnit-CI source, and a non-vitest status-parser contract; wire Restart's `/tests` to render the shell against its own `dataSource`.

**Non-goals:** porting the `/tester` Monaco API explorer or Restart's `DashboardShell`/`Nav`/`?project=` chrome **into** the lib (those stay host-owned, passed via `customTabs` / host wiring); reusing Papercusp's harness/phase/PG machinery in Restart (Restart writes its own thin backend); generalizing the desktop-bound chaos/ai/live walkers (deferred — see D-002).

## Phase 0 — Promote testing-shell to a borrowable shared lib

- **P-001** `done` Detach `libs/testing-shell` into a standalone private repo `github.com/papercupai/testing-shell`, mirroring the `ui-primitives`/`agent-chat` submodule pattern. Keep the `@papercusp/testing-shell` package name + `exports` map unchanged so no importer changes. (Created github.com/Papercusp/testing-shell private + converted libs/testing-shell to a submodule IN PLACE same path, not libs/generic/ — avoids operator downtime + symlink/workspace churn; consistent with libs/agent-chat etc.. commit cbe0addf7. Peers: git submodule update --init libs/testing-shell.)
- **P-002** `done` Add testing-shell to `BORROWABLE.md` + `scripts/gen-borrowable-catalog.mjs`; run `npm run gen:borrowable`. importance: low (Added to gen-borrowable-catalog.mjs under new 'Testing & QA' category; BORROWABLE.md regenerated 25 borrowable + 5 seam'd. Also fixed a pre-existing generator crash stale packages/locks→libs/papercusp/packages/locks; --check green. commit cbe0addf7.)
- **P-003** `done` Re-add it to papercup as a submodule (under `libs/generic/` to match the regrouping) + wire npm workspaces; verify `/admin/testing` and the `/adv` Tests tab still build and render byte-identically. blocked-by: P-001 (Verified post-conversion: lib tests 14/14 from the submodule; node_modules symlink resolves; live harness endpoint returns 22 domains + {universal,project}; :3055 /admin/testing serves 200. Full UI render re-verified in M3 via Tauri. Note: running :3070 host has the OLD registry module cached lib/** no hot-reload — a restart picks up Phase 1.)
- **P-004** `todo` Decide the fate of `apps/operator/lib/testing-domain-glob.ts` (the fs glob-walker): keep server-side per project (default, see D-004) or extract a small borrowable `@papercusp/testing-glob` server util. → D-004

## Phase 1 — Universal tier: decouple from operator paths

- **P-005** `done` Rename `generalizedRegistry` → `universalDomains` in `@papercusp/testing-shell`; tier id `generalized` → `universal`. (It already lives in the lib, so the *definitions* are in the right place.) (generalized→universal renamed throughout lib + operator + .harness contract + HARNESS_TESTING_TIER_LABELS; generalized.ts→universal.ts; commit ec6f85eed. Zero visual change.)
- **P-006** `done` Remove the hardcoded `apps/operator/**` globs/runners from the universal domains. A universal domain declares a **logical role** (`unit`, `endpoints`, `load`, `test-runs`) with **no absolute paths**. This is the fix for the latent bug: today the "Universal" tier glob-walks `apps/operator/**` against each harness worktree, so it is silently **empty for every non-operator harness**. (Role-slot model added commit db0427826: TestSection.role + role-only sections valid; portable 'routes' domain got role:'endpoints' additively. Remaining needs D-002 ratify + desktop nav verify: strip the baked apps/operator/** globs + finalize the portable universal domain set.) (universalDomains narrowed to [routes] role:'endpoints', baked operator globs stripped; test-runs/live/chaos/ai moved to operator. Latent empty-tier bug fixed via per-project resolution. commit ec6f85eed. See D-007.)
- **P-007** `done` Add a **per-project resolution map**: each host supplies `role → globs/runners`. Papercusp maps `endpoints → apps/operator/lib/endpoint-route/__tests__/**`, etc.; the per-harness `.harness/testing-domains.json` gains a `universalOverrides` block. blocked-by: P-006 (Resolution mechanism landed commit db0427826: applyRoleGlobsdomains, roleGlobs — pure, per-project glob fill. Remaining: the .harness/testing-domains.json universalOverrides wiring + operator/Restart role maps.) (applyRoleGlobs + operator OPERATOR_ROLE_GLOBS wired routes resolves locally for /admin/testing; any consumer supplies its own map. commit ec6f85eed mechanism in db0427826.)
- **P-008** `done` Both dashboards merge `universalDomains` (project-resolved) + project-specific domains; tier labels become **"Universal" + "This Project"** (the in-Papercusp harness tab may keep "This Harness"). blocked-by: P-007 (Tiers are "Universal" + "This Harness/Project"; HARNESS_TESTING_TIER_LABELS + .harness contract renamed to {universal, project}; harness-tab test renders both tiers 6/6. /admin/testing keeps its own independent tier scheme. commit ec6f85eed.)
- **P-009** `done` Decide which universal domains ship portable now vs. deferred — the desktop-bound `chaos`/`ai`/`live` cannot run against a non-Tauri project as-is. → D-002 importance: high (Decided as D-002 option b, recorded concretely in D-007 portable set = [routes]; chaos/ai/live/test-runs relabeled Papercusp-specific; generalizing them to drive each project's URL deferred. Reopen if you'd prefer option a.)

## Phase 2 — Missing primitives (ports up from Restart)

- **P-010** `wip` Add `{ kind: 'k6'; script; vus?; duration? }` to `TestRunner` (registry.ts) + `TestRunnerWire` (data-source.ts). Teach `DomainTestPanel` to render the k6 VUs/duration controls + the smoke/load/stress/spike/soak/browser category chips ported from Restart's `/load-tests` page. This makes "Load" a first-class universal domain both projects get. (lib type-level landed commit e223b1875: k6 added to TestRunner + TestRunnerWire + runnerLabel; testing-shell typecheck green. Remaining: DomainTestPanel VUs/duration controls + category chips, and operator run-dispatch k6 execution.)
- **P-011** `todo` Add an optional **streaming run path**: generalize `startRun` to support an SSE log stream (porting Restart's `readSSEStream` live-terminal UX), with the existing `pollRun` as the fallback. importance: low
- **P-012** `wip` Add a **JUnit-XML `'ci'` source**: port Restart's `aggregateJUnit` into the lib as a CI-results producer that feeds `fetchStatuses`/`fetchHistory` with `source:'ci'` (the wire type already reserves `'ci' | 'local' | 'admin-ui'`), plus a rollup + failing-cases panel. Fills a real gap — the shell has no "ingest CI output" view today. (Pure data layer landed commit 95400b21c: JUnit case types + aggregateJUnitCases rollup; dependency-free parsing stays consumer-side w/ fast-xml-parser. Remaining: JUnit→FileStatusEntry status mapping consumer-keyed, the rollup/failing-cases panel UI/desktop, swap Restart's bespoke aggregateJUnit onto this.)
- **P-013** `done` Define a **per-runner output→`ChipStatus` parser contract** so non-vitest runners report status; ship parsers for vitest (JSON), k6 (summary), and `node:test` (TAP). Needed because the harness run route currently hardcodes `npx vitest run`. blocked-by: P-010 (parseRunnerStatus + 6 TDD tests landed in @papercusp/testing-shell commit e223b1875; covers vitest/playwright/cargo/k6/node + signal-kill + skip.)

## Phase 3 — Restart adoption (first external consumer)

- **P-014** `todo` Add `@papercusp/testing-shell` as a submodule in `/home/marsh-office/Restart` `libs/` + npm workspaces (mirrors its 5 existing `@papercusp/*` submodules; React 19 satisfies the `react>=18` peer). blocked-by: P-003
- **P-015** `todo` Add `nuqs` + `NuqsAdapter` to the Restart web app (App Router) and render `TestingShell` as a `'use client'` island under `app/tests/page.tsx` — the same pattern `/load-tests` and `/tester` already use. (Restart doesn't use nuqs yet; trivial add, App-Router-supported.) blocked-by: P-014
- **P-016** `todo` Implement Restart's `TestingDataSource` (the 6 methods) over its own endpoints: single-file runs via `vitest run <file>` in the workspace cwd (nx), k6 via the existing `/api/load-tests/*`, and reuse `junit.xml` for the CI source (flip the `CI`-gated reporter on locally, or run-and-capture). blocked-by: P-013, P-014
- **P-017** `todo` Define Restart's domains: `universalDomains` resolved to Restart globs (`libs/**/src/**/*.{test,spec}.ts`, `apps/**/src/**/*.{test,spec}.ts`) + a project tier (k6 load suites, `ingest-service`/`shop-api` integration). Fold the existing `/load-tests` + `/tester` pages in as `customTabs`. blocked-by: P-016
- **P-018** `todo` Keep `?project=` driving **both** `restart` and `papercusp` through one `TestingShell` (Restart's `lib/projects.ts` already lists both and targets `:3055`). blocked-by: P-017
- **P-019** `needs-human` Sign-off before merging the cross-repo wiring (touches both papercup + Restart on a shared `main`). blocked-by: P-009 importance: urgent

## Phase 4 — Unify the drifted test-config (related cleanup, separable)

- **P-020** `todo` Unify the two diverged `@papercusp/test-config` copies (same package name, an in-repo copy in **each** repo, neither a submodule) into one borrowable submodule like `ui-primitives`, consumed by both. Eliminates config drift and aligns the JUnit-reporter behavior the CI source depends on. → D-005

## Verification

- Phase 0: `/admin/testing` + `/adv` Tests tab build and render unchanged after the submodule swap; `npm run test:affected` green.
- Phase 1: the Universal tier now populates for a **non-operator** harness (regression-proves the latent-bug fix), and tiers render as "Universal" + "This Project".
- Phase 2: a k6 domain runs + streams; a JUnit feed renders the rollup; a `node:test` file reports a real pass/fail chip.
- Phase 3: Restart `/tests?project=restart` renders the shell, lists Restart's tests, runs a single Vitest file + a k6 script; `?project=papercusp` drives the Papercusp adapter from the same UI.

## Decisions

### D-001 — The UI is already abstracted; only the backend is coupled
Date: 2026-06-01
`testing-shell` takes an injected `dataSource` (P-002/P-003 of `harness-tests-tab-and-tester-promotion-2026-05-26`); `/admin/testing` and `/adv` already drive it off two different backends. So adoption is "promote the lib + write a third `dataSource`," not a rewrite. The coupling lives entirely in operator domain globs, the `/api/harness/:slug/testing/*` routes (resolver + phase + PG), and `AcceptancePanel` + the 8 custom tabs — none of it in the shell.

### D-002 — Ship the portable-core Universal tier first; defer generalizing chaos/ai/live
Date: 2026-06-01
Of the five "universal" domains, `routes` (endpoints), `test-runs`, `unit`, and `load` (k6) generalize cleanly across projects; `chaos`/`ai`/`live` are Papercusp-**desktop**-bound (drive the Tauri shell / a Stagehand walk over operator admin routes / operator vitals observers). Recommendation (**option b**): ship a genuinely-universal core now, relabel `chaos`/`ai`/`live` as Papercusp-specific, and treat "generalize them to drive each project's declared base URL" (option a) as a per-domain follow-up. Rationale: gets Restart a real Universal tier immediately without blocking on three web-driver rewrites; a web app like Restart is actually an *easier* driver target than the Tauri shell, so option (a) stays feasible later. Refs P-009. **This is the gate the human must ratify before Phase 1 closes.**

### D-003 — The framework is convention-agnostic; Restart's tests need no rewrites
Date: 2026-06-01
The shell discovers via per-project `globs` and runs via an explicit `runner.kind` (verified: `TestRunner` is a tagged union; there is no extension/path inference anywhere in `libs/testing-shell/src`). So Restart's divergences — `.spec.ts` used for **Vitest** (not Playwright as in Papercusp), tests colocated under `src/`, ~2 `node:test` files run via `tsx --test`, no Playwright/Cargo/pytest, plus k6 + a `.bench.ts` — do **not** break compatibility. The only hard requirement is runner-kind coverage: vitest ✓, k6 (P-010), `node:test` via the `shell` runner + a TAP parser (P-013). No file renames or relocations required.

### D-004 — Keep the glob-walker server-side / per-project, not in the client shell
Date: 2026-06-01
`testing-domain-glob.ts` uses `fs` and is server-only; the shell is client + pure-data. File resolution stays in each project's backend (Papercusp's harness routes; Restart's `dataSource`). Optionally extract the walker into a small borrowable server util later — not required for adoption. Refs P-004.

### D-005 — Unify `test-config` as a follow-up, separable from the shell
Date: 2026-06-01
The two `@papercusp/test-config` copies are drift-prone but the testing **shell** doesn't depend on unifying them; Phase 4 can proceed or be dropped independently. Folding it in is worthwhile because the JUnit-CI source (P-012/P-016) depends on consistent reporter config. Refs P-020.


### D-006 — Sequence in-place generalization before submodule detachment; hold outward-facing + cross-repo steps for the human
Date: 2026-06-01
On "proceed with the plan" (2026-06-01) the agent began executing, with three sequencing calls:

1. **Code-generalize the lib in-place (Phases 1–2) before detaching it (Phase 0/P-001).** The generalization code does not depend on the lib living in its own repo, and it is better to prove the lib is generic in-place than to extract-then-fix. So Phase 2 primitives land first (P-010/P-013 — done this turn), Phase 1 decoupling next, and the submodule detachment last.

2. **P-001 (create github.com/papercupai/testing-shell + push) is held for the human.** It is outward-facing (new remote repo) and requires a `git push`, which is out of the agent's lane here. The agent gets the lib generic in-place; the human creates the repo when ready.

3. **All of Phase 3 (Restart wiring) stays gated by P-019** (cross-repo sign-off on the shared `main`); the agent will not touch the Restart repo until then.

The agent is treating "proceed" as **ratifying D-002 option (b)** — ship the portable Universal core, defer generalizing the desktop-bound chaos/ai/live — pending explicit confirmation. Refs P-001, P-010, P-019.
Related: P-001, P-010, P-019


### D-007 — The portable universal set is just `routes`; test-runs/live/chaos/ai are Papercusp-runtime-bound and moved to the operator
Date: 2026-06-01
Implementing D-002 option (b) concretely (commit ec6f85eed). Of the five domains that were tier `generalized`, only `routes` (endpoint tests, glob-based) is genuinely portable. The other four are Papercusp-runtime-bound in implementation, not just by label: `test-runs` and `ai` use the `admin-suite` orchestrator (Papercusp-specific suites `desktop-health` / `ai-explore-prompts`); `live` watches operator vitals; `chaos` drives the Tauri shell. So:

- `@papercusp/testing-shell` `universalDomains` = `[routes]` only, with section `role:'endpoints'` and **no baked glob** — each consumer fills the glob for its own repo via `applyRoleGlobs`.
- `test-runs`/`live`/`chaos`/`ai` moved into the operator's `testing-domains-registry.ts` as Papercusp `quick` domains (their full defs now live there). `adminRegistry` is unchanged at 21 (1 universal + 20 Papercusp); `papercuspRegistry` went 16→20.
- The operator registers `applyRoleGlobs(universalDomains, { endpoints: ['apps/operator/lib/endpoint-route/__tests__/**/*.test.ts'] })`, so `/admin/testing` resolves `routes` against the operator repo and any other consumer (Restart) supplies its own — which is the fix for the latent "universal tier empty for non-operator harnesses" bug.

Generalizing `chaos`/`ai`/`live` to drive each project's declared base URL (D-002 option a) remains the deferred follow-up. Tier vocabulary `generalized`→`universal` was renamed throughout (lib + operator + `.harness/testing-domains.json` + `HARNESS_TESTING_TIER_LABELS`); zero visual change since the label already read "Universal". Refs P-005, P-006, P-007, P-008, P-009.
Related: P-005, P-006, P-007, P-008, P-009

## Open questions / Deferred follow-ups

- Generalizing `chaos`/`ai`/`live` to drive each project's declared base URL (option (a) of D-002) — deferred per the recommendation; revisit per-domain after the portable core ships.
- Whether the `/tester` Monaco API explorer ever becomes a shared `customTab` (currently: keep host-owned).
- Whether to promote `testing-domain-glob.ts` as `@papercusp/testing-glob` (D-004 leans defer).
- Phase 4 (`test-config` unification) — confirm it's in scope or split to its own plan.
