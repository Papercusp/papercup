---
title: "Investigation brief: `npm run test:affected` core-dumps (Node 25 + vitest worker pool)"
slug: test-affected-coredump-investigation-2026-06-01
status: done
created: 2026-06-01
owner: claude (su-2f904)
tags: [test-infra, vitest, node-version, ci]
---

## RESOLVED 2026-06-01 — `pool: 'forks'` (commit c09cf6b1b)

**Root cause (corrected):** the shared config was **not** "no pool override"
as the brief guessed — `libs/test-config/src/vitest-config.ts` set the unit +
browser layers to **`pool: 'threads'`** (worker_threads). worker_threads share
one libuv loop, which aborts mid-run under Node ≥25 on this kernel (io_uring is
a symptom on *some* runs, not the cause — `UV_USE_IO_URING=0` alone is
insufficient, as the brief already found).

**Fix (candidate #2, chosen over the Node-22 pin #1):**
`pool: layer === 'browser' ? 'threads' : 'forks'`. `forks` is vitest's own
default; it runs each file in its own child process, is stable across Node
versions, and removes the dependency on which Node the runner's PATH resolves.
Chosen over the Node-22 pin because a pool change is robust on every runner
(CI + each box), whereas PATH-based Node pinning re-breaks the moment a runner
resolves a different Node. Wall-clock for the full operator suite ≈ 29s
parallel — no meaningful slowdown, so #2's "slower" caveat did not materialize.

**Verification:** full `npm test --workspace apps/operator` (661 files /
6820 tests) now runs **to completion** on Node 25.9.0 — exit 1 from real test
results, **never** code 134 / "Aborted (core dumped)". Acceptance criteria met.
Insight written: `agent-insights/vitest-threads-pool-node25-coredump`.

### Two findings the fix REVEALS but does not cause (both PRE-EXISTING)

Proven not-introduced: identical failures under the old `threads` pool when a
file is run in isolation (e.g. `distributed-claim.test.ts` → 7 failed under
both pools; `subscriptions.test.ts` → 7 under both).

1. **~60–110 pre-existing unit-test failures** the perpetual crash had masked
   (genuine broken/stale tests, not flake). `test:affected` runs only the
   changed-file closure, and `origin/main` on this box is hundreds of commits
   behind, so these rarely all ran at once before. **Out of scope for this
   infra plan — needs an explicit decision (see below).**
2. **~60 spurious `Test timed out in 5000ms` failures** that appear ONLY at
   full parallelism (forks `maxForks` = CPU count) and **vanish to 0 when
   serialized** (`--no-file-parallelism`). Worst-case-only CPU contention when
   running all 661 files at once; normal `test:affected` subsets don't hit it.

### Pre-existing-failures triage (investigated 2026-06-01, avi said "fix now")

Isolation-tested the failing files one-by-one (each run alone). Findings:

- **`app/**` UI/component tests → mostly CONTAMINATION.** They pass alone and
  fail only in the full suite (shared external-state bleed across files —
  filesystem/CWD/`.harness` paths, the real PG, ENOENT on moved routes, a
  "FileHandle closed during GC" fd leak). Sweep sample: 65/68 passed alone.
- **`lib/**` tests → substantial GENUINE failures** (fail in isolation, proven
  not pool-related — identical under `threads`). The dominant cluster is
  **test-debt from a repo-wide raw-`sql` → Drizzle `getOrgPg().db`
  query-builder migration**: the SUTs (voice-lease, device-pair-store,
  device-harnesses, operator-notes, omp-sessions, execute-action,
  harness-plan-reviews, cooldown-marks, harness-fs-watcher, harness-status-sweep,
  spawn-signing, admin-tables, provision/*, completion-ref-verifier, … ~16+
  files importing `generated`) now query via `db.select().from(generated.X)`,
  but their `vi.mock('@papercusp/db-org')` factories still only provide `sql`
  (and omit `generated`, so they crash at import with vitest's strict
  named-export check). Plus distinct one-offs: `distributed-claim` (7),
  `subscriptions` (7), `experts`, snapshots/`bumpPatch`, css-tokens, etc.

Fixing the genuine cluster is **not mechanical** — each test needs its `db`
query-builder mock rewritten (or conversion to a real-PG integration test per
the testing-spec). That's a strategy call + a multi-session effort. The
contamination is a separate root-cause investigation (find the file(s) that
pollute shared external state). **Both are out of THIS plan's scope (the
core-dump); tracked here for the follow-up.** Status of the follow-up is the
open decision below.

### Pre-existing-failure FIX progress (avi: two-pass — retire outdated, then fix relevant)

**Authoritative classification** (per-file isolation sweep, `forks`):
**38 genuine** failures (fail alone) out of 116 full-suite-failing files; the
other **78 are contamination** (pass alone, fail only in the full suite — a
separate root-cause).

**Pass 1 (retire) result: ~ZERO whole-file retirements.** Every genuine failure
tests a *live* feature whose test drifted from a recent refactor (P-054 tooldef
extraction, raw-`sql`→Drizzle migration, the backup seam, UI/env changes). No
test was found that tests a *removed* feature. (Outdated *assertions* inside
otherwise-relevant tests — e.g. raw-SQL-string `.toContain('DELETE FROM…')` —
are dropped as part of fixing each file.)

**Proven fix patterns (Pass 2):**
1. *Relocated import* → repoint. `@papercusp/agent-mcp/tool-projection` →
   `@papercusp/agent-mcp` (barrel still re-exports `lookupByMcpName`).
2. *db-org strict-export crash* → `vi.mock('@papercusp/db-org', async (orig) =>
   ({ ...(await orig()), getOrgPg: … }))`. `importActual` is side-effect-free
   (connection.ts is fully lazy — verified), so this keeps REAL
   `generated`/`schemaOf`/`withWorkspace` (drizzle `eq`/`and` resolve real
   columns) and only stubs the connection.
3. *SUT migrated to Drizzle `db`/`tx`* → chainable thenable fake:
   `thenable(r) = Proxy(fn,{get:(_,p)=> p==='then' ? res=>res(r) : ()=>thenable(r)})`;
   `db.select` resolves a queued rows array, `insert/delete/update` resolve `[]`
   and are recorded for behavioral assertions. Drop raw-SQL-string assertions.
4. *Empty-mock artifact assertions* (e.g. `expect(tables).toEqual([])` because
   `generated` was `{}`) → assert the real shape instead.

**FIXED + committed so far (13 of 38, all green in isolation):**
- tool-projection import (4): `ipc_echo`, `streaming-tools-migration`,
  `chat-architect.e2e`, `chat-surfaces.e2e`.
- db-org Drizzle / mock-gap: `voice-lease` (reference), `design`, `dev`,
  `operator-scan-lock`, `operator-audit`, `device-pair-store`,
  `device-harnesses`, `power-user-routes`, `operator-state-snapshot`.

**Extra pattern learned:** workspace-registry mocks need `workspacesRoot`
(backup seam reads it at import); ensure-schema is a flat module of `ensure*Table`
DDL helpers — spread the real module + harden the getOrgPg `sql` stub with
`unsafe`/`begin` so they no-op (a Proxy mock breaks vitest's interop).

**REMAINING genuine (25) — by cluster, with the pattern to apply:**
- *endpoint-route 500s (route throws at runtime — TRACE the thrown error, not
  just a mock-gap; capture the 500 response body / route try-catch):* `experts`,
  `agent-tools-device-auth`, `agent-tools-catchall` (also an SSE
  `event: delta` ordering assertion).
- *Relocated/retired path:* `chat-surface-tools` — a source-auditing test with a
  hardcoded list of `app/api/agent-mcp/**/route.ts` paths (the RETIRED Next.js
  routes). Repoint each `file:` to the relocated `lib/endpoint-route/routes/**`
  module, or rework the audit; the *intent* (chat surfaces wire tools
  consistently) is still relevant.
- *Assertion/expectation drift (verify NOT a real regression first):*
  `subscriptions`, `projects`, `roles`, `agent-tools/misc`, `require-principal`,
  `oauth/state`, `runner-aggregate`, `sync-resolver/table-to-query-names`,
  `harness-testing-registry`, `steps`, `OperatorChatSidebar`, `AddPanelCatalog`
  (UI text), `coord-hook`, `auth-posture`.
- *Env-specific assumption:* `desktop` (`/home/…/claude` vs `claude`; similar
  `gh` path) — assert resolved-path behavior, not the bare name.
- *Possibly REAL code issues (don't just patch the test):* `css-tokens` (43
  undefined CSS tokens), `perf-anti-patterns`, `un-hardcode-contract`
  (console.warn), `branch-actions` (5s timeout + FileHandle-GC fd leak under
  Node 25 — `ERR_INVALID_STATE`), `pty-ws`.
- *`bumpPatch is not a function`:* `app/installed/snapshots/page` — import/export
  drift in `InstalledSnapshotsClient`.

**Contamination (78 files, pass alone): NOT yet root-caused.** Shared
external-state bleed in the full suite (filesystem/CWD/`.harness` paths, real PG,
an fd leak). Separate workstream; `test:affected` subsets mostly dodge it.

### JUDGMENT CALLS — recorded for avi's review (do NOT auto-fix product code)

Per avi: where a fix is a judgment call (real code bug vs test drift, or a design
rework), I record it here instead of deciding, and surface the list at the end.
Clear test-drift I fix directly.

Legend — **REAL?** = suspected product bug (verify, don't patch the test);
**BEHAVIOR** = SUT behavior changed, test must endorse it as correct;
**ISOLATION** = test reads real external state (PG/coord/fs) and needs mocking;
**REWORK** = test design no longer fits; **STALE** = looks like a safe
expectation update but I want your ok.

**A. Suspected REAL product issues (don't auto-patch):**
1. `lib/oauth/state.test.ts` — ALL tests fail; `token.slice is not a function`,
   sign/verify return `undefined`. The OAuth **state-token format likely changed**
   (sign no longer returns a string?). Security-sensitive → verify the SUT, not
   the test. [REAL?]
2. `lib/branch-actions.test.ts` — 5s timeout + `A FileHandle object was closed
   during garbage collection` (`ERR_INVALID_STATE`). A **real fd leak** the SUT
   exposes under Node 25 (unclosed `.harness/action-runs/*.log` handle). [REAL?]
3. `app/_lints/css-tokens.test.ts` — `Found 43 undefined CSS token(s)`. Either 43
   genuinely-undefined CSS tokens in the app (real debt) or a stale token
   allowlist. [REAL?]
4. `lib/perf-anti-patterns.test.ts` — the perf-anti-pattern scanner fires; may be
   flagging a real anti-pattern introduced in product code. [REAL?]
5. `lib/un-hardcode-contract.test.ts` — `vitest-fail-on-console: expected test not
   to call console.warn()`; a real `console.warn` now fires in the covered path.
   [REAL?]
6. `lib/endpoint-route/__tests__/auth-posture.test.ts` — "auth-tier drift under
   /admin/:" — an auth-tier assertion changed; could be a **real auth-posture
   regression**. Security-sensitive → verify. [REAL?]
7. `lib/endpoint-route/__tests__/experts.test.ts` — route 500s: `exps is not
   iterable`, `ENOENT …/.harness/experts/EXP-001/SPEC.md`. The experts route
   **migrated its data source** (PG/generated) but the test seeds file fixtures;
   route correctness is unverified. [REAL?/REWORK]
8. `lib/endpoint-route/__tests__/agent-tools-device-auth.test.ts` &
   `…/agent-tools-catchall.test.ts` — routes 500; catchall also has an SSE
   `event: delta` ordering assertion. Trace the thrown error → mock-gap (fix) vs
   real route bug. [REAL?]
9. `lib/pty-ws.test.ts` — `expected '' to contain 'PTYWS_TEST_MARKER'`; the pty
   websocket produced no output — possible real pty/stream regression. [REAL?]

**B. Test-ISOLATION failures (read real external state):**
10. `lib/agent-tools/coordination/__tests__/subscriptions.test.ts` — reads **376
    real coord watches** from PG (`expected [Array(376)] to deeply equal []`); not
    isolated. Needs a clean schema / mocked coord store. [ISOLATION]
11. `scripts/hooks/omp/__tests__/coord-hook.test.ts` — reads the **real coord
    inbox** and finds an actual peer broadcast (`expected [] …got [message from
    su-3a9fa0aa…]`). Needs the coord read mocked. [ISOLATION]

**C. BEHAVIOR changes — test must endorse as correct (recommend fix, want ok):**
12. `lib/agent-tools/projects/__tests__/projects.test.ts` — tool now **returns an
    `{isError:true}` envelope instead of throwing** (the canonical MCP tool error
    contract). Recommend: assert the envelope. [BEHAVIOR→likely fix]
13. `lib/__tests__/harness-testing-registry.test.tsx` — tier label renamed
    **`Built-in` → `Universal`** (`generalized` field). Recommend: update labels if
    the rename is intended. [BEHAVIOR→likely fix]
14. `lib/agent-tools/roles/__tests__/roles.test.ts` — roles tool output
    shape/wrapping changed (`expected false to be true`). [BEHAVIOR]
15. `lib/agent-tools/__tests__/misc.test.ts` — `snapshots:list/get` output shape
    changed (`{ok:false,…}` vs expected snapshot object). [BEHAVIOR]
16. `lib/auth/require-principal.test.ts` — `PrincipalCheckError` shape/match
    changed. [BEHAVIOR]
17. `lib/llm-testing/__tests__/runner-aggregate.test.ts` — aggregate now yields 37
    rows vs 30 expected; verify the extra scenarios are intended. [BEHAVIOR/STALE]
18. `lib/endpoint-route/__tests__/desktop.test.ts` — `buildLoginSpec` now
    **resolves the agent binary to an absolute env-specific path**
    (`/home/…/claude`) instead of bare `claude`/`omp`/`gh` (+ `setup-pty-commands`).
    Intended path-resolution (then assert `endsWith`) or a portability regression?
    [BEHAVIOR]

**D. UI-expectation drift (verify intended):**
19. `app/_components/SetupWizard/steps.test.ts` — wizard step list changed
    (`['embedded-pg','workspace',…]` vs expected 3). [STALE/BEHAVIOR]
20. `app/_components/__tests__/OperatorChatSidebar.test.ts` — a dimension constant
    changed (`expected 225 to be 360`); layout change or regression? [BEHAVIOR]
21. `app/harness/dock/AddPanelCatalog.test.tsx` — UI text "Open new panel" /
    "Built-in" not found (catalog labels changed). [STALE/BEHAVIOR]
22. `app/installed/snapshots/page.test.ts` — `bumpPatch is not a function`:
    import/export drift in `InstalledSnapshotsClient` (snapshots is a flag-cut V1
    surface — confirm it's still live). [STALE/REWORK]

**E. Design REWORK:**
23. `lib/__tests__/chat-surface-tools.test.ts` — source-auditing test hardcoded
    against the **retired** `app/api/agent-mcp/**/route.ts` paths (ENOENT). Intent
    (chat surfaces wire tools consistently) still valid; needs repointing to the
    relocated `lib/endpoint-route/routes/**` modules or an audit rework. [REWORK]

**RESOLVED since recording (verified-intentional SUT changes → test-only fixes,
committed):** #12 projects (isError envelope), #13 harness-testing
(Built-in→Universal), #14 roles (agentRoles→roles payload key), #19 steps (4th
required step `logins`), #20 OperatorChatSidebar (MIN_WIDTH→56), #21
AddPanelCatalog ("Open panel"), #22 snapshots/page (bumpPatch import). Plus
sync-resolver (registry 56→57).

**Also resolved this round (verified test-only):** #17 runner-aggregate (registered
new oracle O4–O6 + architect A3–A6 scenarios), #18 desktop (assert resolved binary
path — buildLoginSpec deliberately resolves the binary; PTY child has no PATH).
#1 oauth/state was a missing-`await` bug (signState/verify went async) — fixed
0→5/6; the residual is now a refined item below.

**Status: 23 of 38 fully fixed + oauth/state at 5/6 (all committed). 14 still
need your call:**
- **Real-bug suspects (verify code):** #2 branch-actions (fd leak), #3 css-tokens
  (43 undefined tokens), #4 perf-anti-patterns, #5 un-hardcode-contract
  (console.warn), #6 auth-posture (auth-tier drift — security), #7 experts (route
  500 / data migration), #8 agent-tools-device-auth + agent-tools-catchall (route
  500s), #9 pty-ws.
- **#1b oauth/state residual:** the `round-trips` test hits **real PG**
  (`harness_shared.oauth_nonces` via getOrgPg) and the cold drizzle construct
  intermittently throws `Cannot read properties of null (reading 'constructor')`
  in relations extraction. Either mock the nonce store / make it an
  `.integration.test.ts`, OR it's a real drizzle-schema cold-construct bug worth a
  look (it lives in `getOrgPg`, so could affect other suites).
- **Test-isolation (mock the store):** #10 subscriptions (reads 376 real coord
  watches; coord went FS→PG, test still sets `PAPERCUSP_COORD_DIR`), #11
  coord-hook (reads real coord inbox).
- **Ambiguous behavior:** #15 misc (snapshots tool returns `{ok:false}` despite
  mocked data), #16 require-principal (resolves "no principal" where a 403
  cap-error was expected).
- **Rework:** #23 chat-surface-tools (audits retired `app/api/**/route.ts` source
  paths; repoint to relocated `lib/endpoint-route/routes/**`).

Tell me per-item (or per-category) whether to fix the test, fix the product code,
rework, or skip — and I'll execute.

### ROUND 3 (avi: "do all in whichever order you think best") — investigated each

**FIXED this round (committed):** coord-hook (unset operator-URL env → deterministic
detached), un-hardcode-contract (ctx.skip() not console.warn for the PG-unreachable
skip). → **25 of 38 fully green + oauth/state 5/6.**

**CONFIRMED REAL (test is correct; needs a product/design fix — did NOT patch the test):**
- **css-tokens** — 43 CSS custom-properties (`--surface`, `--text`,
  `--pc-color-success`, `--bg-warning`, …) are used across ~30 components but
  defined in NO `app/**.css`. Real CSS debt — needs a design-token migration to
  the tier-token scale (read the design docs + design-phase token registry
  first; see `theme-surface-tier-scale` memory). Sizeable, design-sensitive.
- **perf-anti-patterns** — NEW A1–A14 perf anti-patterns exist in app/lib beyond
  the grandfathered BASELINE, AND some baseline entries are stale. Fix the new
  anti-patterns in product code OR regenerate the baseline (read
  `performance.mdx` A1–A14 first).

**Needs investigation → likely product fix:**
- **branch-actions** — the test runs a REAL `bash` spawn (not mocked) and times
  out at 5s; the "FileHandle closed during GC" is collateral from the kill.
  Determine whether the stdout-stream read loop can hang (product — bound it) or
  5s is just too tight for a real spawn here (test — raise timeout / mock spawn).
- **auth-posture** — "auth-tier drift under /admin/:". Security-sensitive: verify
  whether an /admin route's required auth tier genuinely regressed (product fix)
  or the test's tier expectation is stale (test fix). Do NOT loosen the test
  without confirming the route is correctly gated.
- **experts** — route 500 (`exps is not iterable`, ENOENT
  `.harness/experts/EXP-001/SPEC.md`). The test seeds filesystem fixtures whose
  layout no longer matches `experts-data.ts`'s read paths. Align the fixtures to
  the current read paths (test) or fix the route's listing (product) — confirm
  which by reading `experts-data.ts:listExperts`.
- **agent-tools-device-auth + agent-tools-catchall** — routes 500. Investigated:
  the handler is `catchall.find(d=>d.method==='POST').handler` →
  `handleHttpToolRequest` (the tooldef dispatcher). Mocking the route's
  `buildContext` getOrgPg did NOT fix it, so the 500 is **dispatcher-level** —
  likely telemetry `recordInvocation` or the principal-store hitting PG and
  crashing under vitest's Drizzle construct (`null constructor`, same family as
  oauth). Next step: capture the 500 body via `def.handler(req, CTX)` (NOT the
  default export) + mock the dispatcher's PG touch (telemetry/`unscopedDb`).
  catchall also asserts SSE `event: delta` ordering — verify the stream contract.
  NB: the recurring vitest-only `getOrgPg`→Drizzle `null constructor` crash
  (oauth, these 500s, maybe experts/subscriptions) is plausibly ONE root cause —
  a focused fix (mock getOrgPg centrally for unit tests, or fix the schema-spread
  null under vitest module resolution) could clear several at once.

  **CONFIRMED (round 4):** `getOrgPg()` throws `Cannot read properties of null
  (reading 'constructor')` **consistently in vitest** (probe: import getOrgPg →
  call it → throws; production/tsx is fine, operator runs). The crash is in
  Drizzle's `extractTablesRelationalConfig` during the `.db` handle construct.
  Ruled OUT: a static null in the merged schema (probed all 165 keys of
  `{...sharedSchema, ...generatedSchema, ...generatedRelations}` — none null/undef)
  AND vitest `server.deps.inline:[/drizzle-orm/]` (tried — did NOT fix it, so it's
  not a plain drizzle-orm dual-instance dedup issue). So a quick central fix is
  NOT available; it needs deeper Drizzle-relations debugging (likely the
  `generatedRelations` graph referencing a name that resolves to null only under
  vitest's module loader). **Reliable per-test fix meanwhile:** mock
  `@papercusp/db-org` with `getOrgPg: () => ({ sql: <stub>, db: <chainable fake> })`
  — note `db` must be a CHAINABLE fake (`db.select().from()...`), not `{}` (a bare
  `{}` re-500s because resolvers call `db.select`). This unblocks
  device-auth/catchall/experts/oauth-residual/subscriptions. A central
  `getOrgPg`-mock test setup (opt-out for `.integration.test.ts`) would be the
  DRY version once the chainable-fake shape is settled.

  **⚠ ENV BLOCKER (round 4):** vitest currently **won't start at all** —
  `@papercusp/locks` is duplicated across `packages/locks` AND the `libs/papercusp`
  submodule (`libs/papercusp/packages/locks`), so npm refuses ("must not have
  multiple workspaces with the same name"). That's a concurrent agent's in-flight
  locks relocation (commits f7c83bb72 / 2a5790a85 / a034f00fd), NOT this work —
  left untouched. The device-auth chainable-`db` mock above is written + correct
  in shape but UNVERIFIED (reverted from the tree) because no test can run until
  the locks dup is resolved. Once it is: re-apply that mock to
  device-auth/catchall/experts and verify.

**Test-rework (test-only, but involved):**
- **subscriptions** — coord watches are PG-backed (`getOrgPg().sql`); mock it with
  an in-memory watch store (the raw-SQL queries make this fiddly) OR convert to
  `.integration.test.ts`.
- **oauth/state residual** — same shape: mock the `oauth_nonces` store
  (getOrgPg sql) in-memory, OR make it integration. (The cold-drizzle-construct
  `null constructor` crash in `getOrgPg` is worth a separate look — it could
  affect other suites that touch real PG.)
- **chat-surface-tools** — repoint the `SURFACES` audit list from
  `app/api/agent-mcp/**/route.ts` (retired) to the relocated
  `lib/endpoint-route/routes/**` modules, then re-validate the audited
  MCP-wiring strings still exist there.

**Ambiguous behavior (verify intended vs regression):**
- **misc** — `snapshots:list/get` returns `{ok:false}` despite mocked data; the
  tool likely no longer reads via the mocked seam (gated/migrated). Confirm intent.
- **require-principal** — resolves "no principal" where a 403 missing-capability
  error was expected; the principal-resolution order changed. Verify intended.
---

## Objective

`npm run test:affected` cannot complete on the standing dev box — the
`apps/operator` (`@papercusp/web`) vitest run **core-dumps** (`SIGABRT`, exit
code 134) part-way through, non-deterministically. Find the root cause and make
the affected/CI unit suite run to completion again. This is a **test-infra /
environment** problem, not a product regression.

## TL;DR (most likely root cause)

The vitest process runs under **Node 25.9.0**, while the login shell is on Node
**22.21.1**. The shared vitest config sets **no pool override**, so vitest uses
its default parallel worker pool. Node 25.9.0 (current/non-LTS) + vitest 4.1.5's
parallel workers on this kernel appears to crash the worker (one run showed a
`libuv: io_uring_enter(getevents): Operation not supported` → `Aborted (core
dumped)`; a second run core-dumped on a *different* file with no io_uring
message). **Leading fix: run the test suite under Node 22 LTS, and/or pin a
stable pool in the shared config.** A known-good workaround already exists (see
below) so you can unblock immediately while confirming the real fix.

## Symptom (exact)

```
libuv: io_uring_enter(getevents): Operation not supported
Aborted (core dumped)
npm error code 134
npm error workspace @papercusp/web@0.0.1
npm error command sh -c vitest run --passWithNoTests
1 non-quarantined task(s) failed.
```

- Crash point is **non-deterministic**: run 1 died early in `@papercusp/web`'s
  suite; run 2 (with `UV_USE_IO_URING=0`) died later on
  `app/harness/useDebouncedSave.test.tsx` with **no** io_uring message — so
  io_uring is a *symptom on some runs*, not the whole story.
- **Every test that actually executed passed** (✓). It's a worker-process abort,
  not an assertion failure.
- `@papercusp/operator-vite` and other smaller workspaces complete fine; only the
  large `apps/operator` suite crashes.

## Reproduce

```bash
cd /home/marsh-office/papercupai-workspace/papercup
npm run test:affected          # or: npm test --workspace apps/operator
```

## Evidence already gathered (don't re-derive)

| Fact | Value |
|---|---|
| Login-shell node | `/home/linuxbrew/.linuxbrew/bin/node` → **v22.21.1** |
| `npm exec` node (what vitest runs under) | **v25.9.0** (linuxbrew `Cellar/node/25.9.0_1`) |
| vitest | 4.1.5 |
| Shared vitest config | `libs/test-config/src/index.ts` — **no** `pool`/`poolOptions`/`fileParallelism` override (→ vitest default parallel pool) |
| Walker | `scripts/affected-tests.mjs` — `spawnSync('npm', ['run', <script>, '--workspace', ws.dir])`; per-workspace `test` script = `vitest run --passWithNoTests` |
| Crashing workspace | `apps/operator` (`@papercusp/web`) |

The Node-version split is the strongest lead: the systemd `papercup-dev-api.service`
PATH and the npm exec PATH put linuxbrew Node **25.9.0** ahead of the nvm Node 22,
so tooling launched through npm runs on 25.9.0 even though an interactive `node -v`
may show 22.21.1.

## Ruled out

- **Not a product/test regression.** The crash files (`useDebouncedSave`, voice
  tests, etc.) are unrelated to recent changes; failures are SIGABRT aborts, not
  assertion failures.
- **Not solely io_uring.** `UV_USE_IO_URING=0` removed the io_uring message but the
  run still core-dumped on a different file — so disabling io_uring alone is
  insufficient.

## Known-good workaround (unblock immediately)

Running with a **single forked pool, no file parallelism** completes cleanly:

```bash
cd apps/operator
UV_USE_IO_URING=0 npx vitest run <files…> --pool=forks --no-file-parallelism
```

This is how the recent workspace-scoping changes were verified — 58 tests across
`papercusp-root` / `console-launcher` / `role-launch-spec` / `workspace-pin-guard`
+ their `bootstrap-su` / `bootstrap-role` consumers — all green. So the suite
*content* is healthy; only the default parallel pool under Node 25 is unstable.

## Candidate fixes (ranked — verify each before adopting)

1. **Run tests under Node 22 LTS (preferred).** Confirm whether Node 22 +
   default parallel pool is stable (it very likely is). If so, pin the test
   runner to Node 22: add an `.nvmrc`/`engines` + ensure `scripts/affected-tests.mjs`
   (and CI) invoke under Node 22, or fix the PATH ordering so npm doesn't pick up
   linuxbrew Node 25.9.0. Cheapest real fix; keeps full parallelism.
   - Verify: `PATH=<node22-first> npm test --workspace apps/operator` runs to
     completion.
2. **Pin a stable pool in the shared config.** In `libs/test-config/src/index.ts`
   `defineVitestConfig`, set `pool: 'forks'` (and consider
   `poolOptions.forks.singleFork` or `fileParallelism: false`). Fixes it
   regardless of Node version but **slower** — measure the wall-clock hit on
   `apps/operator` before committing to it; consider gating behind an env so CI
   can keep parallelism if it runs on Node 22.
   - Verify: full `npm test --workspace apps/operator` completes green.
3. **`UV_USE_IO_URING=0` in the runner env** — necessary-but-not-sufficient on its
   own (run 2 still crashed). Use only in combination, not as the fix.

Recommended path: confirm (1) first; if the box can't easily switch the test
runner to Node 22, ship (2) as the robust fallback.

## Acceptance criteria

- `npm run test:affected` (and a full `npm test --workspace apps/operator`)
  complete without a `code 134` / `Aborted (core dumped)`.
- The chosen fix is documented (root cause + why), and — if it's the Node-version
  pin or a pool change — captured as an agent-insight
  (`apps/operator-docs/src/content/docs/agent-insights/`) so the next agent
  doesn't lose time to this.
- No tests are silently skipped to make it pass (don't quarantine your way out of
  an infra crash).

## Pointers

- Walker: `scripts/affected-tests.mjs`
- Shared vitest config: `libs/test-config/src/index.ts`
- Test conventions / homes: `CLAUDE.md` (§ "Where new tests go") + `apps/operator/TESTING.md`
- Quarantine mechanism (do NOT use to mask this): `quarantine.txt`
