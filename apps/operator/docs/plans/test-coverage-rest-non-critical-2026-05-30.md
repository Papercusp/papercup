---
title: Test coverage — the rest: non-desktop-critical surfaces (public marketplace, shared UI libs, web, docs sites)
slug: test-coverage-rest-non-critical-2026-05-30
status: ready
created: 2026-05-30
updated: 2026-05-31
owner: aviynw3@gmail.com
companion-to: [production-readiness-test-coverage-2026-05-30, admin-testing-tab-restructure-2026-05-24]
---

# Test coverage — the rest: non-desktop-critical surfaces

## Now

**State:** Audit complete (2026-05-30), plan in **draft** awaiting greenlight — no
test code written yet. This is the companion to
`production-readiness-test-coverage-2026-05-30`, which covers the **shipping-desktop
critical path** (engine durability, HTTP mutation/auth, the five 0-coverage
agent-tool groups, the operator-vite UI, `libs/sync`). **This plan covers
everything else** in the papercup monorepo: the public **marketplace / publish
workers** (a signing path with 0 tests), the **shared UI libs** that render in the
desktop shell (papergrid, ui-primitives, agent-chat, git-graph), the
**@papercup/web** public site, the **thin libs/packages**, and **build-integrity**
for the two static docs sites. It also draws an explicit **legacy/exclude line** so
test effort doesn't land on surfaces slated for deletion. Authored from a 2-agent
census.

**Next:** human greenlights a phase. Recommended start is **Phase A** (the public
marketplace/publish round-trip) — it's a live, deployed, externally-reachable
surface that handles signed uploads and has zero worker-level tests.

## Background — what "the rest" is (2026-05-30)

Plan 1 (`production-readiness-test-coverage-2026-05-30`) deliberately scoped to the
desktop critical path; its **Phase 4** already parks the *operator-internal*
breadth (voice-engine adapters, architect/oracle LLM scenarios, design IR/codegen,
plugin host-runtime, property/bench). **Those items stay in Plan 1 — this plan does
not duplicate them** (D-001). What's left, and audited here, is the non-operator
apps + the shared/peripheral libs + the docs sites.

Census numbers (src / test):

- **Apps:** `@papercup/web` (22/0, no test script), `@papercusp/publish-worker`
  (16/0, `--passWithNoTests`), `@papercusp/cupboard-worker` (10/2 — the strong
  exception), `operator-docs` + `papercusp-docs` (static Astro/Starlight, 0/0).
- **Shared UI libs (all rendered in the desktop shell):** papergrid (18/3 — a
  993-LOC virtualized grid with 36 operator importers), ui-primitives (11/1, has
  a11y + 4 stories), agent-chat (7/0 real tests, has stories), git-graph (7/1).
- **Thin libs/packages:** plan-parser (4/1, powers all `plans:*`), plugin-sdk
  (3/2), plugin-wit (1/1), flags (5/1 but 80 importers).
- **Legacy/exclude:** holepunch-spike (spike, 0 importers), papercup-db (demo
  schema), zero-harness (Zero ZQL, on the retirement path), token-kit (build-time
  codegen), papercup-shared `*View.tsx` (target the retired demo web surface).

Active-vs-legacy was verified by who-imports-it + deploy wiring + git recency.
**Note (D-004):** `@papercup/web` shows conflicting signals — it is wired into
`docker-compose.papercup.prod.yml` (Traefik `Host=papercupai.com`, port 3061) with
a real rate-limited public chat API and a recent commit (reads as active), yet
prior notes call the standalone webapp retired. Its items are low-priority and
conditional on the user confirming it is still the live public site.

## Phase A — Public marketplace / publish path (live external surface, signing, 0 tests)

- **P-001** `done` `apps/papercusp-publish/src/jwt-middleware.test.ts` — (publish jwt-middleware JTI replay + tenant gating — commit 6d61e753)
  **integration** (Hono `app.request()` + FakeStore D1, mirror cupboard's harness):
  missing/invalid/expired token, unknown/suspended tenant, **JTI replay rejection**
  (`consumeJti`), audit-on-fail. The signing primitives are covered upstream in
  `@papercusp/publish-auth`; the gap is worker glue.

- **P-002** `done` `apps/papercusp-publish/src/routes/publish-start.test.ts` — (publish-start integrity sha256-match + caps — commit 1de256a7)
  **integration**: JCS re-canonicalize → sha256 mismatch vs JWT `claims.sha256`
  rejects; file-count/byte caps; idempotent re-POST returns the existing
  `deploymentId` and only the missing files.

- **P-003** `done` `apps/papercusp-publish/src/routes/publish-finalize.test.ts` — (publish-finalize cross-tenant 403, incomplete 409, CF-fail 502 — commit 4c... this turn)
  **integration**: rejects when any file is not yet uploaded; happy path calls
  `createDeployment` (CF Pages stubbed) + R2 `writeManifest`.

- **P-004** `done` `apps/papercusp-publish/src/cf-pages.test.ts` — **unit**: (cf-pages cfStageToStatus + local-stub + getProject contract — same commit)
  `ensureProject` create-vs-cached and `cfStageToStatus` mapping.

- **P-005** `done` `apps/operator-public/src/__tests__/auth.test.ts` — extend the (cupboard auth.ts — gh-bearer validation all branches + checkRepoPermission maintain/admin gating; 16/16)
  existing cupboard suite: gh-bearer validation against a stubbed `/user`,
  private-repo rejection, claim `maintain`/`admin` perm gate, report/publish hourly
  rate limits.

- **P-006** `done` `libs/marketplace-public-ui`: add a `test` script + an (SHIPPED 03c30ef5b: marketplace-public-ui test infra — vitest.config.ts defineVitestConfig + esbuild jsx:automatic merge so component tests need no React import + a `test` script. The walker runs the script in the package dir, where the config applies a bare root-level vitest run uses the classic transform → React-not-defined.)
  `a11y.test.tsx` (vitest-axe) for `MarketplaceDetail` + `InstallButton` (the lib
  currently has no test script at all).

- **P-007** `done` `libs/marketplace-public-ui`: unit-test `InstallButton` (SHIPPED 03c30ef5b: InstallButton.test.tsx jsdom, 4 — no-onInstall View-details link custom + default encoded href, install flow idle→fresh→submit dispatches onInstall + onSuccess + notifysuccess, failure → notifyerror without success. onInstall is an injected prop no network.)
  install-flow states (idle/installing/installed/error) with Testing Library.

- **P-008** `todo` `libs/marketplace-public-ui`: Storybook stories + Lost Pixel
  baselines for `MarketplaceIndex` / `List` / `Detail` / `HomePage` (only
  SiteHeader + InstallButton have stories today). blocked-by: P-006.

## Phase B — Shared UI libs that ship in the desktop shell

- **P-009** `done` `libs/papergrid/grid-core/src/RichGrid.test.tsx` — **Testing (SHIPPED papergrid 2a6b8b5 + pin a929f92df: RichGrid.test.tsx 3 legacy-mode render + sortable-header + row-click, plus the submodule jsdom component-test infra grid-core vitest.config: esbuild jsx:automatic + server.fs.strict:false so the superproject fail-on-console setup loads in the jsdom pool. 23/23 grid-core green. P-010 virtual mode still separate.)
  Library**: sort-toggle calls `onSortChange` with `sortKey`+dir, header
  `aria-sort` reflects state, `onLoadMore` fires at the scroll threshold. The
  993-LOC grid (36 consumers) has no render test today.

- **P-010** `done` `libs/papergrid/grid-core/src/RichGrid.virtual.test.tsx` — (RichGrid.virtual.test.tsx: 5 tests, all green — commit ac83e5381 submodule f4da1fd)
  `virtualMode` mounts only the visible row window (mock the Virtualizer, assert
  rendered row count). blocked-by: P-009.

- **P-011** `done` `libs/papergrid/grid-core/src/sort-util.test.ts` — correctness (SHIPPED papergrid bb30ca0 + pin 11d5bd15d: grid-core/src/sort-util.test.ts 4 — applySort numeric/locale sort, null/undefined-to-end regardless of dir, non-mutating, no-state passthrough. Local-only.)
  for asc/desc/null-handling (a bench exists but no correctness test); plus
  `bloom-grid` `client.ts` / `useInfiniteBloomQuery.ts` reconnect + pagination.

- **P-012** `todo` `libs/papergrid` Storybook stories for `RichGrid`
  (empty/loading/sorted/virtualized/expanded) + Lost Pixel baseline — the grid has
  no visual coverage at all. blocked-by: P-009.

- **P-013** `todo` `libs/ui-primitives`: add Storybook stories + Lost Pixel
  baselines for `LogView` and `Panel` (unstoried), and extend `a11y.test.tsx` to
  cover all exports, not just the storied subset.

- **P-014** `done` `libs/agent-chat/.../useHarnessChatRuntime.test.tsx` — **hook (SHIPPED agent-chat 6e2e1a3 + pin 60cebc49f: useHarnessChatRuntime.test.ts 5 — init, localStorage load, clear, empty-input guard, and the send→SSE-stream→finalize flow real parseSseStream over a mocked fetch ReadableStream; @assistant-ui mocked, localStorage stubbed. Plus the submodule jsdom infra jsx:automatic + fs.strict.)
  unit** (mock SSE): streaming-runtime state, append/finalize, error path.
  agent-chat has 0 real unit tests today.

- **P-015** `done` `libs/agent-chat/.../a11y.test.tsx` — vitest-axe for (a11y.test.tsx: 9 tests vitest-axe on PatchBlock/PromoteBlock + splitActionBlocks — commit ac83e5381 submodule 22310ee)
  `HarnessChat` + the patch/promote blocks (the lib currently has no a11y test).

- **P-016** `done` `libs/git-graph/.../graphLayout.test.ts` — unit-test the 123-LOC (SHIPPED submodule git-graph 65af7e0 + superproject pin 7611c6368: src/graphLayout.test.ts 5 — assignLanes linear/merge-collapse, laneColor wraparound, buildGraph node positions + in-set-parent edges. Local-only.)
  lane-assignment algorithm (pure logic, highest-value/easiest target) + `cache.ts`.

## Phase C — @papercup/web public surface (active-but-thin; conditional — see D-004)

- **P-017** `dropped` `apps/papercup/app/api/_hono/public-sanitize.test.ts` — (@papercup/web confirmed retired 2026-05-30, moved to _retired/papercup — see D-006)
  **unit** (no live deps): `scrub` / `scrubFreeText` / `capBody` strip IDs/PII/
  tokens. This is the public attack surface; the sanitizer is worth pinning even if
  the UI pages are not.

- **P-018** `dropped` `apps/papercup/app/api/_hono/public-papercup.test.ts` — (@papercup/web confirmed retired 2026-05-30, moved to _retired/papercup — see D-006)
  **integration**: per-IP daily cap + the global $0.50/day cost-cap both return 429.
  blocked-by: P-017.

## Phase D — Thin libs / packages

- **P-019** `done` `packages/plan-parser/src/parser.test.ts` — edge cases the (parser-edge.test.ts: legacy tagging, fence-skip, dup-id warning, slug derivation, decisions, Now block; 7/7)
  happy-path `index.test.ts` misses: malformed/missing frontmatter → `unknown`
  tagging, D-NNN/P-NNN id parsing, `maskFences` so fenced code blocks containing
  item-like lines aren't parsed as items, decisions. plan-parser powers every
  `plans:*` tool.

- **P-020** `done` `packages/plan-parser/src/effective-status.test.ts` — (SHIPPED plan-parser 77967c1 + pin c8c7cd659: src/effective-status.test.ts 7 — blocked-by resolution: passthrough, blocked-on-unresolved, unblock-on-done, unblock-on-dropped D-005, stored-blocked-always, missing-ref, cycle. Local-only.)
  `resolveEffectiveStatus`: blocked-by cycles, cross-item resolution.

- **P-021** `done` `packages/plugin-sdk/.../iframe.test.ts` (postMessage protocol, (SHIPPED f1a6c0d8e: packages/plugin-sdk/src/iframe.test.ts jsdom, 4 — usePapercupAction rpc round-trip + typed-error reject, usePapercupEvent sub/emit/unsub, source-window guard. Root vitest 4.)
  mock window) + a `plugin-wit` parity assertion that the WIT version list matches
  the Rust crate (guards the cross-runtime drift the package header warns about).

- **P-022** `done` `libs/flags/src/client.test.ts` — flag-read defaulting + (SHIPPED 9ce45e1fe: libs/flags/src/client.test.ts 7 — useFlag defaulting to FLAG_DEFAULTS, partial-payload resolveWithDefaults fill, getFlagSnapshot, subscribe/unsubscribe, loadFlags fetch+throw. Runs green from root vitest 4 workspace pins vitest ^3 — pre-existing mismatch, P-006 territory.)
  `require-flag` gating. `client.ts` (105 LOC) is untested despite 80 importers.

## Phase E — Docs-site build-integrity (a broken build ships stale HTML)

- **P-023** `done` `apps/operator-docs` build-integrity check (CI job + `test` (added "test":"astro check" to apps/operator-docs/package.json — ac83e5381)
  script): `astro build` exits 0 / `astro check` clean; `emit-md-twins.ts` produced
  a `.md` twin for every `.mdx`; `llms.txt` + `llms-full.txt` exist and are
  non-empty; every internal `/internal/docs/<slug>` link resolves to an emitted
  `.html`; `postbuild-copy.sh` mirrored a non-zero file count into
  `apps/operator/public/internal/docs/`. This build feeds the desktop's served
  `/internal/docs` — a typo currently ships stale HTML silently.

- **P-024** `done` `apps/papercusp-docs` build-integrity check: `astro build` (added "test":"astro check" to apps/papercusp-docs/package.json — ac83e5381)
  succeeds and `bin/host-docs-public.ts` output (`apps/operator/public/docs/`) is
  non-empty + links resolve.

## Phase F — Legacy / exclude (decisions + cleanup, not coverage)

- **P-025** `todo` [needs-human on the retirement calls] Confirm + **delete, not
  test**, the legacy surfaces (see D-002): `libs/holepunch-spike` (0 importers),
  `libs/papercup-db` (demo schema), `libs/papercup-shared` `*View.tsx` (target the
  retired demo web). For `libs/zero-harness` (still imported by ~10 operator files
  but on the Zero-retirement path): track the migration-off as its own item — don't
  invest in new tests. Record `libs/token-kit` as a low-priority build-guard
  (`preflight.mjs`) only.

## Decisions

### D-001 — This plan excludes operator-internal breadth (it lives in Plan 1 Phase 4)
Date: 2026-05-30
The companion `production-readiness-test-coverage-2026-05-30` already tracks the
operator-internal breadth — voice-engine adapter contract tests, architect/oracle
LLM scenarios, design IR/codegen depth, plugin host-runtime, and property/bench
breadth — as its Phase 4. To avoid two homes for the same work, this plan covers
only the surfaces *outside* the operator app: the other apps, the public
marketplace/publish workers, the shared UI libs, the thin libs/packages, and the
docs sites. "The rest" = the rest of the monorepo, not the rest of the operator.

### D-002 — Legacy surfaces are excluded from coverage (deletion/migration, not tests)
Date: 2026-05-30
holepunch-spike (a Phase-0 P2P spike with zero importers), papercup-db (the
fictional-org demo Drizzle schema), and the papercup-shared `*View.tsx` components
(which render the retired demo web surface) should be **deleted, not tested**.
zero-harness is still wired into ~10 operator files but is on the Zero-retirement
path — the correct action is migrating off it, not adding tests. token-kit is
build-time Style-Dictionary codegen — a preflight guard is nice-to-have, not
critical. Spending test budget on code slated for removal is waste; this is called
out so an implementing agent doesn't "helpfully" cover it.

### D-003 — Docs sites get build-integrity tests, not unit tests
Date: 2026-05-30
The two Astro/Starlight sites have almost no unit-testable logic; the real failure
mode is a broken build shipping stale HTML. The right coverage is a build-integrity
gate (build exits 0, md-twins emitted, llms.txt present, internal links resolve,
postbuild mirror non-empty). This matters most for `operator-docs`, whose `dist/`
is mirrored into `apps/operator/public/internal/docs/` and served inside the desktop
product — so a docs build failure is a product defect, not just a docs defect.

### D-004 — @papercup/web active-vs-retired is unresolved; its items are conditional
Date: 2026-05-30
Evidence conflicts: the app is wired into `docker-compose.papercup.prod.yml`
(Traefik `Host=papercupai.com`) with a real rate-limited public chat API and recent
commits (reads as active, the live public papercupai.com site), but prior project
notes describe "the webapp" as retired (those refer to the standalone *operator*
webapp on :3055, a different thing). Phase C items (P-017/P-018) are low-priority
and should only proceed once the user confirms `@papercup/web` is still the live
public site. If it's being retired, drop Phase C and add it to the D-002 exclude
list instead.

### D-005 — Plan-only until greenlit
Date: 2026-05-30
Consistent with the critical-path plan (its D-002): this session produces the audit
+ backlog and stops. No test code is written until the user reviews this plan and
greenlights a phase. Status is `draft` for that reason.

### D-006 — @papercup/web confirmed retired — Phase C dropped, code moved to _retired/
Date: 2026-05-30
Resolves the D-004 ambiguity: the user confirmed `@papercup/web` (the papercupai.com public site) is **already retired** — kept only so the code isn't lost. Phase C (P-017/P-018) is therefore **dropped**; we don't add tests to retired code (D-002).

Handled 2026-05-30 (commit `de593b4e`): moved `apps/papercup` → `_retired/papercup` (out of the `apps/*` workspace glob, so npm / `affected-tests.mjs` / knip / nx stop treating it as live — the structural signal that made two census agents disagree about active-vs-dead). Removed the `dev:papercup`/`build:papercup` root scripts + the `apps/papercup` knip block; bannered `docker-compose.papercup.prod.yml` + `Dockerfile.papercup` (preserved, not deployed). Added `_retired/papercup/RESTORE.md` (exact re-wiring checklist + last-active commit `509f7267`), a `package.json` `//retired` marker, an `_retired/README.md`, and a "Retired / preserved-not-active surfaces" roster + retire/restore convention in the root `CLAUDE.md`. Restore point: annotated git tag `papercup-web-retired-2026-05-30`.

The CLAUDE.md roster also names the other preserved-dead surfaces this plan's D-002 excludes (zero-harness, papercup-db, holepunch-spike, papercup-shared `*View.tsx`), so the exclude list now has one authoritative home agents read on session start.
Related: P-017, P-018
