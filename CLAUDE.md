# Papercup — agent guide

> Invariants + pointers only. The long-form detail behind every pointer lives in
> `/internal/docs` — start at
> [system/repo-conventions](/internal/docs/system/repo-conventions) (deployment
> model, retired surfaces, borrowable libs, branch/commit discipline long form,
> two-port model, database topology, test infrastructure).

> **Environment quick-start:** [`AGENT-ENV.md`](AGENT-ENV.md) — the machine-checked
> repo operating contract (where shared code lives: `libs/` vs `packages/`; how to run
> tests: the hoisted-root `vitest`; the operator-vite `@` cross-tree alias trap). It is
> GENERATED from the real config (`npm run gen:agent-env`) so it cannot drift, and
> `npm run doctor` asserts the same invariants as runnable checks. Read it first if you
> are new to the tree.

## ▶ Running / testing this app — it is the **Tauri DESKTOP app**, not a browser webapp

> The most-ignored rule in the repo. Read it before you try to "open the app".

**The ONLY supported way to run or test the app:**

```bash
cd papercusp-desktop && npm run dev   # from the repo root
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
(`libs/papercusp/_retired/…`), the harness-snapshot system
(`_retired/snapshot-system/`), the legacy web chats
(`_retired/legacy-web-chats/` — OracleDock/OperatorChatSidebar; the pui chat
pane is the only chat surface), the legacy per-slug harness dashboard
(`_retired/harness-dashboard/` — `/harness/$slug` shell/pages/Real-panels; the
design-system primitives AND the dock engine in `apps/operator/app/harness/`
stay LIVE — `/adv`+`/workbench` are built on them), and the chat sidebar's
human Inbox face (`_retired/inbox-pane/` — `InboxPane.tsx`; retired
2026-07-26, `hud-consolidation-2026-07-26` D-001 — every ask it surfaced now
opens as a HUD conversation instead; the data layer, `use-inbox-pending.ts`,
stays live), and the **work-item mail surface** (`_retired/work-item-mail/` —
`messages:send`/`dismiss`/`inbox`/`outbox` + their `cross_harness:` analogs;
retired 2026-07-26, WI-6097. NOT broken — it lost to `coord:send`, which carried
~400× its traffic, and took zero writes in its final 30 days. Durable
work-item-scoped direction is now `work_items:comment` /
`work_items:checkpoint`, **not** `coord:send`, which targets a live session and
does not survive a spawn boundary. All 222 rows are preserved — this was code
removal only. ⚠ the `coord:*` plane — `coord/messages.ts`, `coord_event_log`,
`coord-inbox-bus` — shares the word "messages" and is fully LIVE: match the
surface, never the substring). `lint:no-retired` guards re-imports. (The Mug/Kettle left-rail
tabs, retired under WI-4778, were RESTORED to the LeftSidebar by owner ask
2026-07-14 — they are live again.)

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

## A cross-lane ruling is a plan Decision, recorded the moment it forms

Any agent — not only a fleet leader — who settles a trade-off, ratifies a scope, or issues a
ruling OTHER lanes must follow records it as a plan Decision **at the moment it forms**:
`plans:add-decision { slug, title, body }` (via the structured `### D-NNN` form the tool
produces — a hand-authored `- **D-NNN**` bullet in a plan body is NOT parsed as a decision by
`@papercusp/plan-parser`, so it never surfaces through the mechanisms below). Never record a
governing ruling only as a coord message: a message is not addressable after delivery, so a
peer who received a wrong paraphrase has no way back to the source. A decision is.

This is not a paperwork nicety — it changes outcomes. Observed live on `agent-trap-guards-2026-07-26`:
a fleet member re-read a leader's recorded decision, discovered its own earlier report to the
leader had been wrong on most of the sites it touched, self-corrected unprompted, and swept up
several more instances of the same error. A coord message cannot produce that outcome.

Two mechanisms make this cheap in practice:

- **At claim time**, `scheduler:get_next` / `work_items:claim` inline a claimed item's plan's
  current decisions as `planDecisions` in the tool result — no extra round-trip. Read it before
  building; a ruling that governs your item may be sitting right there.
- **When relaying a ruling over coord**, name the decision id (`<planSlug>#D-NNN`) rather than
  only paraphrasing it, so the recipient can re-read the authoritative body
  (`plans:get { slug, heading:'Decisions' }`) instead of trusting your summary.

## Branch discipline: the shared tree stays on `staging`; `main` is automation-only

- The canonical shared checkout (the repo root you are working in) **always has
  `staging` checked out**. Work on `staging` directly — **no `git worktree`, no
  feature branches**; coordinate via `locks:*` (per-edit hook is automatic) + `coord:*`
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

> ⚠ **`git blame` on this repo never tells you who wrote a change — never trust it
> for attribution, especially in an escalation.** git-sync commits the whole tree
> under one identity, so blame is a false-positive generator, not a dead end —
> trusting it once sent a false blocker accusation to the owner ("confirmed by git
> blame: YOUR migration") for an agent's own incomplete work (WI-5111). Recover
> authorship from the commissioning work-item/plan-item or a timestamp-correlated
> `sessions:search`; if neither resolves, say "not attributable" — never name a
> person. Full runbook:
> [attributing-a-change-despite-git-sync-squash](/internal/docs/agent-insights/attributing-a-change-despite-git-sync-squash).

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

**"Is my change live, and if not what is the ONE thing blocking it" is ONE call —
`dev:pipeline_position { path }` — never a hand-diff.** It answers three *different*
questions that agents routinely conflate; hand-resolving them cost 11 tool calls and 4
`merge-base`/`git log` diffs on 2026-07-26 and still went wrong twice:

| you want to know | read | not |
|---|---|---|
| is it live, and if not the ONE lever | `blockedOn` + `nextAction` (the `summary` now LEADS with them) | the row of position ticks — a boolean per stage cannot say whether that stage is *moving* |
| is this leg stuck, or just slow | `stages[].health` (`advancing`/`stalled`/`disabled`/`broken`) | `positions.*` alone — that read a 2h52m push freeze as "not yet" |
| did my work reach origin | `gitSync.pushedRepos` | `gitSync.status` — `'synced'` is reachable with **nothing** pushed |
| is the running process executing my code | `serving.startedSinceCodeChange` | `positions.deployed` — a git fact stating a process conclusion ("deployed ✓" ≠ live; filed 4× independently) |
| is the gate judging MY code | `changeInCandidate.judgingContainsPath` | assuming a red is about your change — a run judging a candidate without it isn't |
| will the next tick commit my half-finished refactor | `sweepExposure` (blast radius + when) | nothing — git-sync sweeps the WHOLE tree, so `git-sync:run` mid-refactor commits the broken intermediate on purpose |

`nextAction: null` is a **positive** answer ("waiting is correct"), never a missing one —
do not invent a lever when the honest move is to wait. Full field-by-field guide:
[reading pipeline state](/internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction).

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
  server-side edit live: **`dev:restart { target: 'staging', confirm: true }`**,
  then probe `:3170`. **Never** shell out to a raw
  `systemctl --user restart papercup-staging-api.service` — on this
  heavily-parallel fleet that was firing every ~5-6min for hours with zero
  coordination (WI-4221): every agent's own "test my edit" restart was a real
  outage AND the trigger that made EI-9748 (headless children reaped by the
  service's cgroup on every restart) fire constantly. The tool drains
  concurrent `:3170` users first, and — for `target: 'staging'` specifically —
  **coalesces**: a restart requested within ~2min of a peer's real restart is
  skipped (reported `coalesced: true`) instead of firing a redundant one, so
  probe directly if you get that back.
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
  files are *projections*. `dev:pg_query` is for **genuinely ad-hoc / analytic** reads
  (a one-off group-by, join, or recency slice you won't run repeatedly). A HOT read with
  a stable shape belongs behind a TOOL that wraps the canonical SQL so it can't drift —
  e.g. "what's claimable" is `work_items:claimable`, NOT a raw floor query (see the
  claimability note below). **Before you write `SELECT`, check this table** — these are the
  reads agents most often hand-write, and each already has a tool that scopes + applies the
  real semantics for you:

  | you want | use | not |
  |---|---|---|
  | what issue-family work is claimable now | `work_items:claimable { harness }` | `WHERE status='open'` / the `work_items_claimable` view (overcounts ~13×) |
  | a filtered work-item / issue slice | `work_items:list` (server-side filters) | a hand-written `harness_shared.work_items` query |
  | what plans exist / the recent ones | `plans:list { updatedSince, createdSince, order, limit }` | a hand-written `harness_shared.harness_plans` query |
  | plan COUNTS (by status / harness / day) | `plans:list { groupBy, aggregateOnly }` | a hand-written `GROUP BY` over `harness_plans` |
  | pickable plan items across plans | `plans:items { actionable: true }` | unnesting the items jsonb |
  | prose / full-text | `search:fulltext` · `search:semantic` | `ILIKE '%…%'` |
  | code graph / call sites | `gitnexus.query` (dot, not colon — a plugin-namespaced MCP tool, not the usual `server:verb` form) | a hand-walk of the tree, or raw `grep -r`/`rg` over source (grep gives file/line matches; gitnexus.query gives call chains + callers/callees) |

  Nothing in the table fits and the shape is genuinely one-off? Then **`dev:pg_query`**
  (read-only SELECT — read-only txn + `statement_timeout` + row cap) or a server-side
  `*:list` filter — never fetch a whole `*:list` and `jq`/python a spilled projection.
  If you find yourself writing the *same* query a second time, that is the signal it
  should be a tool (or an arg on one), not a snippet. (su can also `psql` the admin URL directly:
  `getHarnessAdminUrl()` / the live operator's `DATABASE_URL`.) ⚠ Multi-tenant
  tables (`harness_plans`, the `*_consolidated` tables, …) key on
  `(workspace_id, harness_slug, <slug/id>)` — a raw filter on just the slug/id
  can silently hit a different tenant's row and look like a stale/diverged
  store when it isn't:
  [raw SQL plan reads need workspace+harness scope](/internal/docs/agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope).
  ⚠ For CLAIMABLE issue-family work (bug/change/task), `status='open'` is **NOT**
  claimability — the real claim path applies ~12 unconditional floors, so a raw
  `WHERE status='open'` overcounts ~13×. Use the dedicated tool
  **`work_items:claimable { harness }`** — the authoritative count + rows + per-floor
  `excludedBreakdown`, wrapping the SAME oracle `scheduler:get_next` runs (so it can't
  diverge from what the queue actually serves). Do **not** hand-roll floors in SQL over
  `harness_shared.work_items` / the `work_items_claimable` view, and do **not** treat
  `work_items:list{admissibleOnly:true}` as the claimable verdict — `admissibleOnly` is
  only a cheap STRUCTURAL pre-filter (remote-origin + observation-lane), NOT the full claim
  floors. (`scheduler:get_next`'s own `excludedBreakdown` is the same oracle if you're
  already calling it.) For issue-family human-routing the signal is `payload.needsHuman`,
  NOT the feature-family `needs_human_review` column:
  [judging claimable work — status='open' is not claimability](/internal/docs/agent-insights/judging-claimable-work-not-status-open).
- ⚠ **Apply migrations via the runner (`db:migrate`)** — a raw `psql -f` runs
  DDL without recording it in `harness_shared.schema_migrations`, so every
  deploy re-runs it; a lock-contending re-run trips the deploy's 15s
  `lock_timeout` and rolls back (wedged all deploys ~1h on 2026-06-09). If you
  must `psql -f`, INSERT the schema_migrations row in the same transaction.

Full guide (acceptable file uses, two-axes model, topology):
`/internal/docs/system/storage-policy` +
[repo-conventions § database topology](/internal/docs/system/repo-conventions).

## Reaching for bash? These reads already have a tool

Bash is still ~41% of all tool use here, and the audit behind this table found the
cause is routing, not capability. Of the tools that replace a shell command,
`dev:pg_query` was the only one this file already pointed at — and it is the only one
with real adoption (~85%, against ~1% for equally-capable tools nobody was pointed
at). So the table below is the lever — and it is **generated from the same registry
the PreToolUse gate enforces**, so the advice you read here and the advice the hook
gives you cannot disagree.

Each row was earned, not asserted: a frozen sample of real commands from this box was
replayed against the tool's actual argument envelope, and only pairs where every
sampled command has a faithful tool expression appear here. Where the tool genuinely
could not do the job the **tool was widened** (that is where `capability:read`'s
`tail:` and `dev:pg_query`'s `describe:` came from) — and where it still cannot, the
row says so and bash remains correct.

<!-- BEGIN GENERATED gen:tool-routing — do not edit by hand -->

> Generated from the audited substitution pairs — run `npm run gen:tool-routing`.
> Every row below is backed by an `equivalent` verdict computed from a frozen
> sample of real commands (`packages/operator-core/lib/bash-substitution/`), and
> the PreToolUse gate enforces the SAME registry. Do not hand-edit: the source is
> `pairs/*.ts`, and `npm run gen:tool-routing:check` fails the build on drift.
> Adding a row, promoting one, or arguing with a gate that blocked you:
> [bash vs tool routing](/internal/docs/agent-insights/bash-vs-tool-routing).

| you want | use | not |
|---|---|---|
| a line RANGE of one file | `capability:read { file_path, offset, limit }` | `sed -n 'N,Mp' FILE` (offset=N, limit=M-N+1) |
| the WHOLE of one file | `capability:read { file_path }` | `cat FILE` (a heredoc or redirect is a WRITE — not this) |
| the FIRST N lines of a file | `capability:read { file_path, limit: N }` | `head -n N FILE` (a `… \| head` pipe filter is not this) |
| the LAST N lines of a file (a build / gate log tail) | `capability:read { file_path, tail: N }` | `tail -n N FILE` (`tail -f` streaming has no tool form — keep using bash) |
| a one-off SELECT against the OPERATOR database | `dev:pg_query { sql }` (read-only txn + row cap + statement_timeout) | `psql -d papercusp -c "SELECT …"`. ⚠ ONLY the operator DB — a `$VAR`/other-database connection has NO tool form, so keep using psql for those rather than risk querying the WRONG database |
| a table's columns / indexes / constraints | `dev:pg_query { describe: "schema.table" }` (a `*` glob lists relations) | `psql -c "\d table"` (`\df`/`\dn`/`\du` are other object classes — no tool form) |
| whether a systemd unit is active / failed | `dev:service_health { units:["<unit>"], scope }` — unitStates[].{loadState,activeState,active,failed} for any unit, plus unitsUnknown[] for ones systemd does not know; services[].up / supervision[].healthy for registered units | `systemctl --user is-active <unit>` — note it prints `inactive` for a unit that does not exist, which the tool reports as unitsUnknown instead |
| whether a local dev service is answering | `dev:service_health` — for the probed set (incl. :3170 staging), when you need only up/down | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/api/health` — still required for :8788 and other unprobed ports, and whenever you read the body |
| what is listening on a TCP port / which process owns it | `dev:listening_ports { port }` (or `{ pid }` for the reverse lookup) — structured rows with pid, command and ownerVisible | `ss -ltnp` / `lsof -nP -iTCP:<port> -sTCP:LISTEN` / `netstat -tlnp`. ⚠ LISTEN sockets only — an established-connection query (`ss -tn`, `netstat -an`) or one lsof call spanning several ports still needs bash |
| to read git state (status/log/diff/show/rev-parse/merge-base) | `capability:git { args: ["log","--oneline","-5"], cwd? }` — argv, no shell, gated as git | `git log --oneline -5` — bash is not WRONG here; the gain is argv-safety and git-scoped gating. Shell-substituted argv (`git -C "$D" …`) has no tool form. For "is my edit live", prefer `dev:pipeline_position { path }` |
| to run specific test files and see which tests failed | `testing:run { files: [...] }` | `npm run test:file -- <paths> 2>&1 \| tail -60` (a run redirected to a log file is not this — the tool writes no artifact) |
| to run test files without hand-picking a Vitest config | `testing:run { files: [...] }` | `npx vitest run <path>` (a root-level run can match zero files and still exit 0 — the router refuses that) |
| a service's log lines in a time window, filtered | `logs:read { unit, since, grep?, level?, limit? }` (filter pushed down to `journalctl --grep`; repeats collapsed) | `journalctl --user -u <unit> --since <w> \| grep <pat> \| tail -n` (a streaming `-f` follow, a boot/cursor selection, or `sudo` elevation has no tool form — keep using bash for those) |
| to typecheck a project and see the errors | `build:typecheck { project: "packages/operator-core" }` | `npx tsc --noEmit -p <project> 2>&1 \| grep …` (the tool refuses a run that checked ZERO files — `-p .` does that here, and a `grep` over its one-line error prints nothing, which reads as clean) |
| the current date/time | `host.now` — already in your coord:orient payload (ISO-8601 UTC). Call nothing | `date` / `date -u` / `date +%s`. ⚠ a `$(date …)` substitution INSIDE another command is string interpolation — keep using bash; so is `date -d @<epoch>` (a different instant) |
| the load average / how busy the box is | `host.load` + `host.cores` — already in your coord:orient payload. Call nothing | `uptime` (`uptime -p` / `-s` ask for BOOT TIME — a different question, still bash) |
| how many CPU cores this machine has | `host.cores` — already in your coord:orient payload. Call nothing | `nproc` / `nproc --all` |
| free memory / whether the box is out of RAM | `host.memFreePct` + `host.psiMemSome60` — already in your coord:orient payload. Call nothing | `free -h` / `free -g` |
| to install dependencies in this shared tree | `npm run install:safe` (or `npm run install:safe -- ci` / `-- install --legacy-peer-deps`) — serializes concurrent agents behind an fs-mutex, then verifies every declared dep actually landed on disk | a bare `npm install` / `npm ci` — it rewrites `node_modules/.bin` under every other agent's in-flight test run, and two overlapping installs corrupt a package durably. ⚠ NOT claimed: an install naming a package operand (it may target a scratch tree `install:safe` cannot reach) or `--dry-run` |

<!-- END GENERATED gen:tool-routing -->

The tool call is also cheaper than the shell round-trip it replaces: a structured
result, no subprocess, and no output to re-parse. When a row's caveat applies (a
`tail -f` follow, a non-operator database, a `\du`), the bash form is the right
answer — the gate will not fight you on those.

## Long jobs: background them at the LAUNCH, don't poll for them afterwards

**"Is my job done?" is 12% of every bash call on this box** — ~2,950 calls in 7
days across 63 of 86 sessions: `ps`/`pgrep` (2,315), polling a task-output file
with `cat`/`tail`/`wc -c` (1,120), and bare `sleep` (1,082, and what follows a
sleep is overwhelmingly another poll). None of that is recoverable by swapping
the poll command, because the fix is one step earlier:

> For anything that runs longer than ~1–2 min, start it with
> **`capability:bash { run_in_background: true }`** and read it with
> **`capability:bash_output { bash_id, filter }`**. The `filter` regex means only
> matching lines enter your context — no `2>&1 | tail -60`.

**Why the tool and not native `run_in_background`:** not because the tool is
crash-proof — it is not. Its in-memory job registry is wiped whenever *any* agent
restarts the operator on this shared box (EI-8855). The difference is
**recoverability**. `capability:bash` writes the job log to a deterministic
`stateDir + bash_id` path, so a poll after that still returns the log tail plus a
**confirmed** cause (`stranded_by_operator_restart` vs `job_process_gone`,
decided by comparing operator uptime to the log's age — EI-18666279107998059). A
native background id is bookkeeping inside the CLI child's own memory: after a
compaction, carry-respawn, or cold-loop wake it is simply a dead reference with
nothing to recover (EI-16611).

So: **checkpoint the `bash_id`, never a native task id**, and never write "await
background task `<id>`" as a successor's next action.

Do not sit in a `sleep`/poll loop waiting on work you did not launch either —
prefer the push path (`events:await`, a completion event) over polling; see the
"never wait for a calm window" and force-the-deploy rules above.

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
abused as one. `DarkCase` splits the set into two populations governed differently (WI-4495 — a
single aggregate ceiling used to penalize adding a legitimate safety kill-switch exactly as hard as
parking finished work, which is why the watermark kept getting silently raised 22→24→25→26 for the
SAME bug class every time): the `DARK_FLAGS_HIGH_WATERMARK` size ceiling in
`libs/flags/src/types.ts` (imported by `production-defaults.test.ts`) governs ONLY the
**`parked`/`incomplete`** subset (`DARK_FLAGS_PARKING_COUNT`) — the actual parking-lot abuse; it
**fails the build if THAT subset grows**, not the aggregate `DARK_FLAGS.size`. `owner-authority` /
`cutover` entries (permanent or staged safety kill-switches) are **not rationed** by the watermark at
all — they are governed only by the `DARK_FLAGS_REVIEW_BY` re-review date, so a legitimate new safety
flag never has to fight a parking-lot budget. So: flipping a `parked`/`incomplete` flag ON *removes*
its allowlist entry (the parking subset shrinks ✓); shipping a NEW genuinely-incomplete flag dark
requires first **graduating an existing parked/incomplete dark flag** to make room (net-zero) or
**explicit owner sign-off** to raise the watermark — never a quiet append. **Do NOT route around this
guard** by re-introducing a second dark allowlist, a per-flag `process.env.PAPERCUSP_*` gate, a
`darkReason` side-table, or any other parking-lot for finished-but-scary work: the temptation to park
it dark "to verify later" is *exactly* the abuse this exists to stop — flipping it on and watching it
work IS the task.

## Tests after editing

```bash
npm run test:affected                  # unit only — fast, default
npm run test:affected:integration      # also runs *.integration.test.ts
npm run lint:tsc -- --files=<the files you edited>   # TYPES — vitest does not typecheck
```

⚠ **`test:affected` is TYPE-BLIND — a green run does NOT mean your change compiles.**
Vitest transforms via esbuild/swc, and neither `scripts/affected-tests.mjs` nor
`lint:affected-gate` invokes `tsc` at all. So a type-only regression is invisible to
the routine loop and first surfaces at the **green-checkpoint** hours later, where it
reds the gate for the whole fleet and costs a peer the diagnosis. **Run
`npm run lint:tsc -- --files=packages/operator-core/lib/a.ts,…/b.ts` after editing** —
it gates a PER-FILE baseline scoped to exactly the files you name (fail-soft), which is
what makes it usable while operator-core still carries ~200 pre-existing errors that
would otherwise drown your one new one.

> ⚠ **Name the files; do NOT use `--mine` on this tree.** `--mine` infers "your" files
> from `git status`, and this repo has ONE working tree shared by the whole fleet with
> every agent's edits sitting unstaged until the next git-sync tick — so `--mine` means
> "dirty in the tree", i.e. *yours and every peer's*, and it will report a file you never
> opened as "1 file(s) YOU changed". This is one of the most-repeatedly-filed frictions
> here (EI-18731016038876755, which added `--files` precisely to fix it, plus three
> later duplicates). Both directions cost you: you chase a peer's error believing it is
> yours, or — worse — your own genuine regression arrives amid peer noise all labelled
> "YOU changed" and you dismiss the lot as fleet drift. `--files` is the only form whose
> attribution is trustworthy here.

⚠⚠ **`lint:tsc` typechecks `packages/operator-core` ONLY** — it is a single
`tsc -p packages/operator-core/tsconfig.json` (`scripts/lint-tsc.mjs`). A change confined
to another workspace — **`libs/generic/*`, `libs/papercusp/*`, `apps/*`, other
`packages/*`** — is typechecked by NEITHER `lint:tsc` NOR vitest, so a type-only
regression there is invisible to *both* routine checks and first reds the
**green-checkpoint**. Editing outside operator-core? Also typecheck that workspace —
**`build:typecheck { project: "<workspace>" }`** (EI-18719561823587590).

> ⚠ Use the tool, not a hand-run `npx tsc -p . --noEmit`, and this is a correctness
> point rather than a style one: **there is no root `tsconfig.json` in this repo** (only
> `tsconfig.base.json`), so from the repo root `-p .` and `-p tsconfig.json` fail
> instantly with TS5057/TS5058 having typechecked **zero files**. Those are the two most
> common project operands in the whole 7d corpus, and 45 of 425 decidable `tsc`
> invocations (11%, across 24 of 86 sessions) checked nothing. What makes it expensive is
> how it reads: 42% of those runs were piped into `grep`, and a `grep <my-file>` over a
> one-line TS5057 prints **nothing at all** — indistinguishable from "my file is clean" —
> while `2>&1 | tail` throws away tsc's exit code too. `build:typecheck` refuses a
> zero-file run instead of reporting a clean zero, and names the projects that do exist.

**The trigger to watch: adding a REQUIRED field to a shared interface** (or renaming
/ re-typing one). Every fixture that constructs that type elsewhere goes stale
instantly, in files your change never touched and `test:affected` never selects — and
a stale fixture in a file whose tsc baseline ALREADY tolerates errors is invisible to
the ratchet too, so it stays silently broken rather than loudly red. This bit three
separate changes on 2026-07-26 alone (`AgentFact.confidence`,
`OwnerSteering.createWakeSuppressPlans`, `PipelinePosition.submodulePin`). After such
a change, grep the field's type name across the tree and check every construction
site — the baseline will not do it for you.

Schema/migration edits (`libs/papercusp/libs/db/**`) → `npm run
test:all:integration` (the dependency graph won't catch them). Don't run
`npm run test:all` for routine edits. Each app/lib ships a `TESTING.md` — read it
before adding tests. Infra (Vitest 4, testcontainers PG, Docker required, CI,
property tests, knip, quarantine, secrets):
[repo-conventions § test infrastructure](/internal/docs/system/repo-conventions).

**npm only — never `pnpm`/`yarn` in this repo, even for a single-package test
run.** This is an **npm workspaces** monorepo (root `package.json`'s
`preinstall` runs `only-allow npm`); there is no `pnpm-workspace.yaml`. Running
e.g. `pnpm --dir packages/operator-core test` doesn't see npm's workspace
linking for internal `@papercusp/*` packages (they resolve via a plain `"*"`
version range, no `workspace:` protocol) — pnpm instead tries to fetch them
from the public registry and fails on the first private/unpublished one (e.g.
`@papercusp/audio-dsp`), a confusing error unrelated to your change (EI-7243).
For one or more exact test files, always use the repository router:

```bash
npm run test:file -- path/to/one.test.ts path/to/two.integration.test.ts
```

It discovers each file's owning workspace, runs from that workspace with its
unit or integration Vitest config (so app-local `@/` aliases resolve correctly),
prints requested versus matched/executed files, and hard-fails a zero or partial
match before executing. Do not hand-compose a root-level `vitest --config …`
command: there is intentionally no universal root config, config include globs
are cwd-relative, and the same-looking command can silently select zero files.
Pass additional Vitest flags after a second `--`, e.g.
`npm run test:file -- path/to/file.test.ts -- --reporter=verbose`.

**`npm install`/`npm ci` on this shared tree is a mutation every OTHER concurrent
agent can see mid-flight — serialize it, never run it bare.** `node_modules` is
unsynchronized global mutable state: one agent's install rewrites `node_modules/.bin`
out from under every other agent's test run (`vitest: not found` / a bare
`ERR_MODULE_NOT_FOUND` into `node_modules` — neither error names the real cause), and
two OVERLAPPING installs can leave a package durably HALF-WRITTEN (e.g. a `dist/`
with only `.d.ts` files, zero `.js` — not a version-resolution problem, does not
self-heal) (EI-18662389554660036). Always run **`npm run install:safe`** (passes
through to `npm install` by default; `node scripts/npm-install-safe.mjs ci` /
`... install --legacy-peer-deps` for other subcommands) instead of a bare `npm
install`/`npm ci` — it serializes concurrent installs across every agent process on
the host via a filesystem mutex (`scripts/lib/fs-mutex.mjs`, keyed off the repo
root's real/symlink-resolved path) before the rest of the tree ever sees a rewrite.
If a test run ever fails with the signature above, another agent is very likely
mid-install right now — `npm run test:file` detects it and prints a
`TEST_FILE_MID_INSTALL_SUSPECTED` hint instead of leaving you to chase a phantom bug;
wait for it to finish (or check `ps aux | grep 'npm install'`) and retry.

⚠ **Hit a confusing "cannot find module" / Rolldown "failed to resolve" for a package
that IS in `package.json`? Run `npm run doctor:deps` BEFORE you suspect a code bug.**
Concurrent installs can leave npm's reify bookkeeping believing a dependency is
resolved (it's in `package-lock.json`, and `node_modules/.package-lock.json` is
newer) while the tarball was never extracted — so `npm install` prints "up to date",
exits 0, and the first symptom is an unrelated build/gate failure 10+ minutes later
(EI-18666853411437489: 8 declared `mem0ai` peers missing on disk blocked a gate; two
agents each mis-diagnosed it as a code bug first). `doctor:deps`
(`scripts/check-declared-deps-extracted.mjs`) checks in ~0.2s that every
directly-declared dependency of every workspace actually resolves on disk, and
`install:safe` now runs the same check automatically after a successful install
(repairing once with a full `npm install --legacy-peer-deps`, then failing loudly)
so the corruption surfaces at the install, not in someone else's build.

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

> **Editing a live tool counts too.** In practice nearly every prompt-weight gate
> red has come from *growing* an existing tool's `description`/`guidance`, not from
> adding a new one — and an editor never reads an "Adding a tool" section, so the
> breach lands committed and freezes the fleet gate hours later. Run the same
> `tools-md-sync` quick-check after ANY description/guidance change, not just an
> add. Backstop (EI-10966): the live operator now re-checks the prompt-weight
> budget at tool-registration and warns in its OWN log the moment a hot-reloaded
> edit goes over budget — so a skipped quick-check surfaces in the operator, not
> only at the fleet gate.

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
scenarios** `packages/operator-core/lib/llm-testing/scenarios/<role>/`. **Never** new
`.mjs` integration scripts or tsx smoke scripts (CI lint P-038 fails the build).
`npm --prefix apps/operator run lint:tests` guards registry coverage — if it
fires for a new subsystem, widen a domain in
`packages/operator-core/lib/testing-domains-registry.ts` then `npm run
gen:contract` (root). See `/internal/docs/testing` §1.0a.
