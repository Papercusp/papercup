# Papercup — agent guide

> Invariants + pointers only. The long-form detail behind every pointer lives in
> `/internal/docs` — start at
> [system/repo-conventions](/internal/docs/system/repo-conventions) (deployment
> model, retired surfaces, borrowable libs, branch/commit discipline long form,
> two-port model, database topology, test infrastructure).

## ▶ Running / testing this app — it is the **Tauri DESKTOP app**, not a browser webapp

> The most-ignored rule in the repo. Read it before you try to "open the app".

**The ONLY supported way to run or test the app:**

```bash
cd /home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop && npm run dev
```

Then drive the **Tauri window** it opens (agent-driven UI checks:
`/internal/docs/testing/agent-e2e`). That one command boots embedded PG, the
operator sidecar, migrations, and the webview. There is no "just the webapp"
mode.

> **You CAN — and therefore MUST — verify UI yourself; "I can't check UI
> headless" is a mistake, not a constraint.** Launching this shell is within
> YOUR reach (run the command above — it's just `npm run dev`; first cargo build
> ~2 min), and you then drive its webview **head-lessly, no focus-steal**, with the
> **`tauri-agent-tools`** CLI: `probe` · `eval` · `dom` · `click` · `type` ·
> `screenshot` · `check` (CI-style assert, exits 0/1) · `capture` (screenshot +
> DOM + console + logs). Full playbook: `/internal/docs/testing/agent-e2e` §0–§2
> (attach to a running shell, or start your OWN second instance). Therefore a UI
> task is **NEVER** "blocked on a Tauri/desktop session," and UI is **NEVER**
> "unverifiable headless." If you catch yourself deferring, punting, or shipping
> UI work as un-testable-without-a-human, STOP — that *is* this mistake: start the
> shell and drive it. (For non-Papercusp/arbitrary web pages, `verdict`; the
> operator UI only renders correctly inside Tauri, so never point `verdict` or a
> browser at `:3055`/`:3070`.)

- **Never open `:3055` or `:3070` in a browser** (verdict / playwright / chrome /
  `xdg-open`). They are the desktop's *internal content source* — a browser view
  is the **retired** webapp and gives a broken/misleading result. A `PreToolUse`
  hook blocks the navigation.
- **Never start `apps/operator` as a standalone Next server** (`next dev` /
  `next start`) — retired. (The root `bin/dev`/`bin/prod` launchers are NOT the
  forbidden thing — they boot the Vite `:3055` + Hono `:3070` stack and invoke
  no Next.)
- A `curl http://127.0.0.1:3070/...` for a quick **API** check (not a UI check)
  is fine while the desktop is running.

The `:3055`/`:3070` layer **is the desktop's content layer**, not a separable
webapp — what's retired is the *act of running/browsing it standalone*. Detail +
the transport/persistence table:
[repo-conventions § deployment model](/internal/docs/system/repo-conventions).

## Almost all state should be in nuqs

**If a piece of state is reasonably user-meaningful, it goes in the URL via
[nuqs](https://nuqs.dev), not `useState`.** Non-negotiable: the agent → UI
control surface (`ui:get_state`, `ui:dispatch`) reads/writes the URL — anything
in `useState` is invisible to agents.

- **nuqs:** tab/view/mode selectors, panel/drawer/dialog open-state, selection
  ids, search/filter/sort/pagination, expansion toggles.
- **useState:** loading/saving/error lifecycle, mid-edit drafts, hover/focus,
  toasts, ref-coupled sync values, render-only state.

**When in doubt, choose nuqs.** Prefer `parseAsStringEnum` > `parseAsBoolean` >
`parseAsString` > `parseAsJson(shapeGuard)`; encode complex selections as a
short scalar (`"review:<id>"`) + `useMemo` lookup, never 1KB of JSON. Rationale +
the migrated params: `apps/operator/docs/nuqs-audit-2026-05-11.md`.

## All client data sync goes through `@papercusp/sync`

Reads via `useSyncQuery({ queryName, args })`; writes fire
`notifySyncInvalidate(...)` (+ `useSyncMutate` for the hook). **Never** hand-roll
`fetch + setInterval`, SWR, React-Query, or a raw `EventSource` for query data —
the library is the one audited path (SSE-primary on desktop, WS in browser, REST
fallback). Zero is **retired**; ignore `libs/zero-harness`.

Wiring: resolver entry in `packages/operator-core/lib/sync-resolver/index.ts`
(read) + `notifySyncInvalidate` from `packages/operator-core/lib/sync-sse.ts`
after the write commits. Genuine exceptions (byte streams, UI timers,
operator-mobile's polled path) and the full recipe:
`/internal/docs/data-sync` + the
[adding-a-sync-query](/internal/docs/agent-insights/adding-a-sync-query) insight.

## Scheduling: no bare `setInterval`, no new scheduler

Recurring work has exactly **two execution mechanisms** + **one declaration surface** — don't
add a third. Durable + Postgres-backed → a **DBOS scheduled workflow** (or a `tier:durable`
routine fired by `routinesTick`). A frequent in-process bounded sweep → declare a
**`tier:ephemeral`** blueprint `triggers.schedule` (deterministic `system:<action>` + `intervalSec`;
the per-host `ephemeral-executor` runs it). A watchdog / per-connection / cache timer that must
stay bespoke → still wrap it in `managedSetInterval(name, ms, fn, { category })` so it is VISIBLE
in `schedule:inventory` (*visibility ≠ control*). A bare `setInterval` fails
`lint:no-raw-setinterval` (the BASELINE is empty). Full model:
[the scheduler layer model](/internal/docs/agent-insights/two-tier-scheduler-and-timer-visibility).

## Deployment model: desktop is the product; the standalone webapp is RETIRED

Shipping target = the Tauri desktop app; **desktop SSE is the sync path that
matters** (browser WS is a dev fallback — a feature that only works under WS is
incomplete). Source of truth:
`apps/operator/providers/HarnessSyncProvider.tsx`. Transport table +
stale-docs-to-mistrust list:
[repo-conventions § deployment model](/internal/docs/system/repo-conventions).

## Retired / preserved-not-active surfaces

Some code is **retired but deliberately kept** — not deleted, not deployed, not
tested, not to be extended. Don't write tests for it, wire new code to it, or
"revive" it without an explicit ask. Currently: `_retired/papercup/` (public
site), the standalone operator webapp path, `libs/zero-harness` (migrate off),
`libs/papercusp-db`, `libs/holepunch-spike` (NOT zero-importers — shim implemented
by live orchestrator files), `libs/papercusp-shared/**/*View.tsx`, the legacy
orchestrator run-loop + orchestrator-spawn plugin
(`libs/papercusp/_retired/…`), and the harness-snapshot system
(`_retired/snapshot-system/`). `lint:no-retired` guards re-imports.

Full table with restore points + the retiring-a-surface convention:
[repo-conventions § retired surfaces](/internal/docs/system/repo-conventions).

## Borrowable libraries — generic-first

Domain-free libs live as standalone submodules under `libs/generic/*`; the
catalog is `BORROWABLE.md` (generated — `npm run gen:borrowable`). **A genuinely
domain-free algorithm STARTS as `libs/generic/<name>` behind a `configure*()`
seam** — never inside `operator-core/lib` to be extracted later. `npm run
lint:generic-first` (advisory) flags violations; incidental keyword hits go in
the `ALLOW` set in `scripts/check-generic-first.mjs`. Long form + the seam
pattern: [repo-conventions § borrowable](/internal/docs/system/repo-conventions).

## This app is in testing — there are no users yet

There is no production. **Don't defer fixes for "let's see how it fares in
production first"** — there's nothing to fare in. **Be bold — in alpha, timidity
is the failure mode, not breakage.** The genuine mistakes are the cautious ones:
preserving a design you know is wrong, back-compat shims, deprecation aliases,
half-fixes to dodge churn. When the correct fix is a breaking change — a schema
migration, an API redesign, a rename, ripping out a load-bearing-but-wrong
abstraction — **make it now, in full**: redesign instead of layering, rename
instead of aliasing, migrate schemas when they're correct, pick the best
tool/library not the safe one, prefer a maintained library or existing internal
surface over rolling your own, lift anything general into a shared/generic lib.
Surface what you're changing to whoever supervises your work; don't ask
permission to do it well.

## A blocker is work, not a stop sign — resolve it, don't just relay it

Hit a blocker — something in scope that's hard/big/risky, a failing dependency,
a broken tool, an env/config fault, a wedged service? **Don't pause to hand it
to the owner. Investigate the root cause, fix it, and fix it DURABLY** — resolve
the whole class so it can't recur, not a one-off patch that leaves the trap
armed for the next agent (a half-fix is the real failure mode here). Escalate to
a human ONLY when the fix is genuinely irreversible / high-stakes, outside your
authority, or you've actually tried and can't resolve it — and even then, bring
your diagnosis + a proposed durable fix, not just the blocker. Whatever you
genuinely can't resolve now, record durably on the work-item
(`work_items:set_state` → `blocked`, with a reason) — never a prose message that
scrolls away — and carry it forward in every status report.

> Interactive (human-present) PSU sessions can still take a fast redirect from
> the owner, but the default is resolve-don't-relay; the human-session specifics
> live in the PSU engineer playbook (EI-148).

## Branch discipline: the shared tree stays on `staging`; `main` is automation-only

- The canonical shared checkout
  (`/home/marsh-office/papercupai-workspace/papercusp`) **always has `staging`
  checked out**. Work on `staging` directly — **no `git worktree`, no feature
  branches**; coordinate via `locks:*` (per-edit hook is automatic) + `coord:*`
  (declare-intent), not tree isolation.
- **`main` is the GREEN branch** — it only fast-forwards to a staging commit
  that passed the green-checkpoint suite; nothing and no one pushes it directly
  (a pre-push hook blocks you).

## Commit discipline: git-sync owns commit + push — you do neither

A background **git-sync** routine commits the whole shared tree and pushes to
`origin/staging` on a schedule (superproject + every submodule). **No `git add`
/ `commit` / `push`, no stashing/branching to isolate "your" diff** — just leave
work in the tree. Merge conflicts go to a `merge-resolver` agent, not you. From
`staging`, green-checkpoint (hourly) FFs `main` and release-trigger (≤15 min)
auto-deploys it to `:3070`. Pipeline view: `/admin/git`. Long form + symptoms:
[repo-conventions § branch + commit](/internal/docs/system/repo-conventions).

> 🚨 **NEVER run a tree-wide destructive git op on the shared checkout** — not
> `git reset --hard`, not `git checkout .` / `git checkout -- :/`, not
> `git clean -fd`, not `git stash`. The tree is edited CONCURRENTLY by the whole
> fleet, and everyone's edits sit **unstaged** until the next git-sync tick — so a
> tree-wide reset/checkout/clean/stash **silently and irrecoverably wipes every
> peer's in-flight work** (it was never committed, so it is not in any git object;
> kopia backs up only ~14KB of workspace-state, NOT the code). This is not
> hypothetical: on 2026-06-21 a `git reset --hard HEAD` (an agent "cleaning the
> tree" between commits) discarded a tested, in-flight fix and is the root cause of
> the recurring "my edits got reverted/overwritten by a concurrent fixer" reports
> that burned hours of fleet time. **To discard only your OWN change to ONE file,
> re-edit that file by hand** (or, only after confirming via `coord:presence` /
> `locks:list` that no peer holds it, `git checkout -- path/to/that.one.file` with
> an explicit path — never a pathspec-less or `.`/`:/` discard). If you think you
> need a clean tree, you don't: just stop editing and let git-sync commit. A Bash
> guard rejects these commands on the shared checkout — do not route around it.

**Never sit in a wait/poll loop for git-sync to "push your change" or the deploy to
land — force it instead.** The pipeline is async: keep working, and locate your edit
with `dev:pipeline_position` (not a browser). But when your *next step genuinely
requires* a code change to be **live on `:3070`** before you can proceed (you must
exercise it through the running operator), do **not** idle waiting for the scheduled
commit→checkpoint→deploy. **Force the deploy now:**
`PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute`.
⚠ The `PAPERCUSP_ALLOW_DEV_RESTART=1` is **required** on the dev box — without it the
restart step is *withheld* and deploy-cli's auto-rollback leaves `papercup-release`
inconsistent (git files vs node_modules/build), which crash-loops `:3070` on
`MODULE_NOT_FOUND` (recover: `systemctl --user stop papercup-dev-api.service` then re-run
the command above with `--no-drain`). Blocking on git-sync / the green gate before
continuing is the anti-pattern; force it and move on.

## Server-side edits and the two-port model — no hot-reload

The Hono host (`bin/hono-host.ts`, MCP tools, `lib/endpoint-route`,
`apps/operator/lib/**`) has **no file-watch**, and on the dev box a `:3070`
restart does **NOT** pick up your edits:

- **`:3070`** = GREEN operator, runs from the **release checkout**
  (`papercup-release`, `main`). Your staging edits reach it only via the
  auto-serve pipeline (or a manual
  `PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute`
  — the env flag is required for the restart; see the force-deploy note above).
- **`:3170`** = staging operator, runs from the integration tree. To test a
  server-side edit live: `systemctl --user restart papercup-staging-api.service`,
  then probe `:3170`.
- The Tauri dev shell spawns its own operator from the integration tree.

(`:3055` Vite *does* hot-reload.) Probe where the write actually lands; if it's
stale, restart the *right* host and re-probe. Detail:
[repo-conventions § two-port model](/internal/docs/system/repo-conventions).

## Before you design or test — read the docs first

Two `/internal/docs` sections are **required reading before the corresponding
work**, not optional references. Check them *first*, then act:

- **Before ANY design work** — new or changed UI, an API/schema shape, an
  architecture, or a new durable surface (component, tool, table, service) —
  read the **design docs** at [`/internal/docs/design`](/internal/docs/design)
  and check the `design-phase:*` tools (the DTCG token set + component registry)
  for what already exists. Don't hand-roll a design without checking the system
  first.
- **Before ANY testing work** — writing, adding, or changing tests, or verifying
  behavior — read the **testing docs** at
  [`/internal/docs/testing`](/internal/docs/testing) (+
  [`/internal/docs/testing/agent-e2e`](/internal/docs/testing/agent-e2e) for UI).
  They say which of the four canonical frameworks to use and how (see also
  "Where new tests go" below).

## Read this before changing code — performance anti-patterns

Performance regressions here repeatedly come from the same small set of patterns
(serial fs loops, per-slug PG-pool opens, `<details>` gating, duplicate React
keys, stale Radix pointer-events overrides, …). **Read
`/internal/docs/performance` before any non-trivial change** — especially the
"What NOT to do" sections (A1–A14). If your change matches an anti-pattern,
change the approach first.

## Storage policy: Postgres by default

**New durable state goes in Postgres unless there is a specific reason it must
be a file.** No plain-JSON state files, no module-scoped TTL `Map`s, no "PG
mirror with file primary". Helpers: `apps/operator/lib/operator-state-pg.ts`.

- **Schema = migrations only; NO runtime DDL.** ⚠ **Pick the migration number
  via the atomic allocator — NEVER `ls sql/ | tail` by eye.** On this
  heavily-parallel fleet, two agents racing an `ls`-then-write gap WILL pick
  the same NNN (EI-6843 — cost a rename + every in-code reference + re-verify
  when caught). Run `node scripts/next-migration.mjs --name <slug> --intent
  "..."` (or `npm run db:next-migration --`) FIRST — it reserves the number
  atomically under an advisory lock (`harness_shared.migration_reservations`)
  and prints the exact path to write. Then add the idempotent migration at
  `libs/papercusp/libs/db/sql/<NNN>-…sql` (≥107), and run
  `node libs/papercusp/libs/db/scripts/pull-schema.mjs`. Never an `ensureXxx()`
  / inline `CREATE TABLE`. `000-baseline.sql` is frozen/generated.
- **Never hardcode `localhost:5432`** — resolve via `getHarnessAdminUrl()`.
  Embedded-pg is the ship target; the dev box runs native PG on `:5432`.
- **Reading PG-canonical state? Query PG — don't dump-and-jq a projection.**
  Plans, work-items, issues, observations (`engineer_issues`), `tool_invocations`,
  scorecards, recipes live in Postgres; the `*:list` tools and `docs/plans/*.md`
  files are *projections*. For a filtered / aggregate / recency read, use
  **`dev:pg_query`** (read-only SELECT — read-only txn + `statement_timeout` + row
  cap) or a server-side `*:list` filter — never fetch a whole `*:list` and
  `jq`/python a spilled projection. (su can also `psql` the admin URL directly:
  `getHarnessAdminUrl()` / the live operator's `DATABASE_URL`.)
- ⚠ **Apply migrations via the runner (`db:migrate`)** — a raw `psql -f` runs
  DDL without recording it in `harness_shared.schema_migrations`, so every
  deploy re-runs it; a lock-contending re-run trips the deploy's 15s
  `lock_timeout` and rolls back (wedged all deploys ~1h on 2026-06-09). If you
  must `psql -f`, INSERT the schema_migrations row in the same transaction.

Full guide (acceptable file uses, two-axes model, topology):
`/internal/docs/system/storage-policy` +
[repo-conventions § database topology](/internal/docs/system/repo-conventions).

## Feature flags + PostHog

Single source of truth for keys/defaults: `libs/flags/src/types.ts`; flip flags
via `/admin/features`, not JSON or PostHog directly. Gate cuttable features from
day one (`requireFlag` / `useFlag` / `gateApiRoute` / Hono middleware / MCP
registration) — **a feature toggle is a `FLAGS` entry, never an ad-hoc
`process.env.PAPERCUSP_*` boolean** (an env gate ships dark, dodges the default-on
guard + the dark-flag expiry, and can't be flipped at runtime; `lint:env-feature-gates`
enforces this in CI — env stays for launch-time/test/dev config only). **New flags
DEFAULT TO ENABLED — finished work never ships dark.** A flag left OFF means the code does
NOTHING in production, so a feature you built, tested, and left gated OFF is DEAD CODE and the
task is NOT done — however green the tests. **Flipping it ON is the FINAL STEP OF THE SAME TASK,
never a "someday" and never a hand-off** (and a flag flipped on only via a runtime override while
its DEFAULT in `types.ts` stays `false` is the same half-finish — change the default). ⛔ The #1
way good work silently dies is "ship it dark, verify/flip later" — PgBouncer AND claim-auto-convert
BOTH sat built+tested+OFF for weeks. KILL the two excuses that cause it: (i) **"the owner flips it
after verifying."** NO — if YOU built it and it's tested, YOU verify it: flip it ON, watch it work
live, flip it OFF only if it breaks. Verify-then-flip is ONE atomic step YOU own in THIS task, not
a punt to the owner or to "later"; the owner asked for a working feature, not dead code awaiting a
ceremony. (ii) **"it's reversible / safe to ship dark."** Reversibility is the reason to flip it ON
*confidently*, not a license to leave it OFF. Default-OFF is allowed ONLY for: genuinely
INCOMPLETE/unsafe code (it doesn't fully work yet), an OWNER-AUTHORITY/security surface the owner
must personally ratify (privilege-escalation, destructive reapers, public signup, full-autonomy),
or a reversible CUTOVER kill-switch needing an attended live verify the OWNER runs — and "finished
but I'd like it verified first" is NONE of these (that verify is YOUR job, in-task). When one of
those three genuinely applies — and then (a) add it to
`KNOWN_DARK_FLAGS` in `libs/flags/src/production-defaults.test.ts` with a
justification (CI fails otherwise), and (b) surface the pending flip loudly in the
plan's `## Now` + your completion report. The dark allowlist carries a
`DARK_FLAGS_REVIEW_BY` expiry, so a dark flag can't linger silently. Reference:
`/internal/docs/posthog` + `/internal/docs/posthog/feature-flags`.

⛔ **The dark allowlist is SHRINK-ONLY — never reconstruct or grow it, and never build a parallel
one (owner mandate 2026-06-23).** `KNOWN_DARK_FLAGS` exists ONLY to express the small set of
genuinely-not-ready exceptions above (incomplete code / would-break-the-running-fleet /
owner-authority / staged-cutover) — it is **NOT a parking lot for finished work**, and it was being
abused as one. A high-watermark test (`DARK_FLAGS_HIGH_WATERMARK` in `production-defaults.test.ts`)
**fails the build if the dark set grows**. So: flipping a flag ON *removes* its allowlist entry (the
set shrinks ✓); shipping a NEW genuinely-incomplete flag dark requires first **graduating an existing
dark flag** to make room (net-zero) or **explicit owner sign-off** to raise the watermark — never a
quiet append. **Do NOT route around this guard** by re-introducing a second dark allowlist, a
per-flag `process.env.PAPERCUSP_*` gate, a `darkReason` side-table, or any other parking-lot for
finished-but-scary work: the temptation to park it dark "to verify later" is *exactly* the abuse this
exists to stop — flipping it on and watching it work IS the task.

## Tests after editing

```bash
npm run test:affected                  # unit only — fast, default
npm run test:affected:integration      # also runs *.integration.test.ts
```

Schema/migration edits (`libs/papercusp/libs/db/**`) → `npm run
test:all:integration` (the dependency graph won't catch them). Don't run
`npm run test:all` for routine edits. Each app/lib ships a `TESTING.md` — read it
before adding tests. Infra (Vitest 4, testcontainers PG, Docker required, CI,
property tests, knip, quarantine, secrets):
[repo-conventions § test infrastructure](/internal/docs/system/repo-conventions).

## Browser checks — use `verdict`

Ad-hoc/exploratory browser verification → the `verdict` skill, **not** Playwright
MCP tools or ad-hoc Puppeteer. Playwright is only for running/extending the
committed `apps/operator/e2e/*.spec.ts` suite. `verdict` is for
**arbitrary/external** pages — operator UI (`:3055`/`:3070`) is verified inside
the **Tauri shell** per `/internal/docs/testing/agent-e2e`, never by pointing
verdict at those ports.

## Use Context7 for current library docs

Before non-trivial APIs from third-party libraries (Tauri 2, Next.js 15, nuqs,
Hono, Radix, Vercel AI SDK, Vditor, BlockNote, …), call the `context7` MCP tools
(`resolve-library-id` → `get-library-docs`). Library APIs change faster than
training cutoffs; don't guess from memory.

## Adding a tool — the per-role guidance discipline

1. **Define** in `packages/operator-core/lib/agent-tools/<group>/<verb>.ts` (or
   `packages/agent-mcp/src/tools/...` for read-side).
2. **Import** it from `packages/operator-core/lib/agent-tools/index.ts`.
3. **Add `guidance: { when, notWhen?, chaining?, byRole? }`** — `when` first.
4. **Chat surfaces**: add `mcp__agentmcp__<group>:<verb>` to that surface's
   `allowedTools` (operator-converse:
   `packages/operator-core/lib/operator-mcp-tools.ts`; oracle:
   `packages/operator-core/lib/agent-tools/oracle/prompts.ts`).
5. **Run** `cd packages/operator-core && npx vitest run tools-md-sync` — green
   before commit. This quick-check now also enforces the P-011 prompt-weight
   budget (≤1500 soft / ≤1600 hard per tool's description+guidance), so an
   over-budget guidance edit reds HERE instead of silently wedging the green
   gate (EI-7284).

Per-tool when/not-when goes on the tool; cross-tool patterns in
`<role>.tools.md`; behavior rules in `<role>.persona.md`. The split is
intentional — see `packages/operator-core/lib/prompt-assembly.ts`.

## Prompts are auto-generated — edit the source, never the rendered output

Every agent-facing prompt is assembled at launch/spawn from sources: chat-surface
roles from `apps/operator/prompts/<role>.{persona,tools}.md` + the tool-guidance
catalog; psu playbooks from
`apps/operator/prompts/papercusp-su-{engineer,power}.tools.md` (which splice
THIS `CLAUDE.md` in as the Project guide — repo-convention changes belong here);
harness spawn prompts from `libs/papercusp/packages/harness/prompts/<role>.md`.
**Never edit rendered outputs** (`~/.papercusp/*-collaborator*.md`, anything
under `papercup-release`, captured prompts). Dev edits load immediately
(`PAPERCUSP_RELOAD_PROMPTS=1`). After a `<role>.tools.md` edit run the
tools-md-sync test; after a substantial SU-playbook edit run
`npm --prefix apps/operator run llm-test -- --target su`. Long form:
[repo-conventions § prompts](/internal/docs/system/repo-conventions).

## Where new tests go — four canonical frameworks

Every new test goes in **exactly one** of: **Vitest**
`<package>/lib/**/<name>.test.ts` · **Playwright**
`apps/operator/e2e/<name>.spec.ts` · **Cargo** `#[cfg(test)]` · **LLM
scenarios** `apps/operator/lib/llm-testing/scenarios/<role>/`. **Never** new
`.mjs` integration scripts or tsx smoke scripts (CI lint P-038 fails the build).
`npm --prefix apps/operator run lint:tests` guards registry coverage — if it
fires for a new subsystem, widen a domain in
`packages/operator-core/lib/testing-domains-registry.ts` then `npm run
gen:contract` (root). See `/internal/docs/testing` §1.0a.
