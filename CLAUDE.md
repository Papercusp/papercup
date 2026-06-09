# Papercup — agent guide

## ▶ Running / testing this app — it is the **Tauri DESKTOP app**, not a browser webapp

> This is the most-ignored rule in the repo. Read it before you try to "open the app".

**To run or test the app, launch the desktop shell — the ONLY supported way:**

```bash
cd /home/marsh-office/papercupai-workspace/papercup/papercusp-desktop && npm run dev
```

Then drive the **Tauri window** it opens (for agent-driven UI checks see
`/internal/docs/testing/agent-e2e`).

**Do NOT "launch the web version":**

- **Never open `:3055` or `:3070` in a browser** (verdict / playwright / chrome /
  `xdg-open`). Those ports are the desktop's *internal content source*, not a
  standalone site — a browser view is the **retired** webapp and gives a
  broken/misleading result. A `PreToolUse` hook blocks browser navigation to them
  and points you back here.
- **Never start `apps/operator` as a standalone *Next* server** (`next dev` /
  `next start`). That Next standalone path is **retired** (`next.config.js` guards
  against it), and a `PreToolUse` hook blocks browser nav to its ports. (Note:
  `bin/dev` / `bin/prod` still exist and are NOT the forbidden thing — they boot the
  Vite SPA `:3055` + Hono host `:3070` stack and invoke no Next; what's retired is
  running/browsing the old Next webapp, not those launchers.)
  (Older docs say it "fails loud because native PG was renamed `papercusp_legacy`";
  that mechanism is stale — see the Database-topology section: native `papercusp`
  is alive on `:5432` and is what the dev box uses.)
- A `curl http://127.0.0.1:3070/...` for a quick **API** check (not a UI check) is
  fine **while the desktop is running**.

The operator's Next/Vite/Hono layer on `:3055`/`:3070` **is the desktop's content
layer** — `papercusp-desktop` points its webview at `:3070` and spawns
`npm --prefix ../papercup run dev:operator` itself. It is **not** a separable
"webapp" and **cannot be moved to `_retired/`** without breaking the desktop. The
retired thing is the *act of running/browsing it standalone* — see "Retired /
preserved-not-active surfaces" below.

## Almost all state should be in nuqs

**If a piece of state is reasonably user-meaningful, it goes in the URL via [nuqs](https://nuqs.dev), not `useState`.** This is non-negotiable. The agent → UI control surface (`ui:get_state`, `ui:dispatch`) reads/writes the URL — anything in `useState` is invisible to agents and undriveable without a per-feature intent.

**What goes in nuqs:**
- Tab / view / mode selectors (`?tab=...`, `?mode=...`)
- Open/closed state of panels, drawers, dialogs, dropdowns, banners
- Selection state (`?proposal=...`, `?feature=...`, `?slug=...`, `?file=...`)
- Search/filter inputs (`?q=...`, `?filter=...`)
- Sort/pagination (`?sort=...`, `?page=...`)
- Expansion / show-debug / show-timeline toggles

**What stays as `useState`:**
- Loading / saving / busy / streaming / error lifecycle flags
- Mid-edit form drafts (typing-in-progress that would lose on reload)
- Hover / focus / drag mouse-state
- Transient toasts, copied-indicators, animation tweens
- Ref-coupled state where a `useRef` must read the value synchronously (e.g. xterm search-addon coupling)
- Sub-millisecond render-only state (`mounted`, `RefreshKey`)

**When in doubt, choose nuqs.** It's strictly more capable: agents can read it, users can deep-link to it, reloads survive it. Defaulting to `useState` is the legacy habit — break it.

For the parser, prefer in this order: `parseAsStringEnum<T>([...allowed]).withDefault(...)` for closed enums, `parseAsBoolean.withDefault(...)` for toggles, `parseAsString.withDefault('')` or `parseAsString` (nullable) for open strings, `parseAsJson(shapeGuard)` for discriminated unions.

If a state encodes a complex object (like a `{kind:'review'|'thread', id}` selection), encode it as a short scalar (`"review:<id>"`) and derive the full object via a local `useMemo` lookup. Don't put 1KB of JSON in the URL.

See `apps/operator/docs/nuqs-audit-2026-05-11.md` for the rationale + the 46+ params already migrated this session.

## Deployment model: **desktop is the product. The standalone webapp is RETIRED.**

**Source of truth: `apps/operator/providers/HarnessZeroProvider.tsx` lines 6–19** (the "Transport selection by deployment context" doc-comment).

The shipping target is the **Tauri desktop app**, and it is also the only supported test surface. The old `next dev` / `bin/prod` standalone webapp path (running `apps/operator` directly and opening `localhost:3055` in a browser) is **retired as of 2026-05-14** — the `apps/operator/bin/{dev,prod}` standalone entrypoints are gone (the root `bin/dev`/`bin/prod`, which boot the Vite SPA + Hono host and invoke no Next, remain), and a `PreToolUse` hook blocks browser nav to its ports. (Older text says native PG was renamed `papercusp_legacy` to make boots fail loudly; that mechanism is **stale** — native `papercusp` on `:5432` is alive and is this dev box's substrate. See the Database-topology section.)

**To run / test the app, launch the Tauri dev shell:**

```bash
cd /home/marsh-office/papercupai-workspace/papercup/papercusp-desktop
npm run dev
```

That single command boots embedded Postgres (writes `~/.papercusp/embedded-pg.json` discovery file), starts the operator sidecar against it, applies pending SQL migrations, and opens the Tauri webview. There is no longer a "just the webapp" mode.

Ports you may see internally (do not open these in a browser; let the desktop drive them):
- `:3055` — the operator's **Vite** dev server (TanStack-Router SPA, `@papercusp/operator-vite`) consumed by the Tauri webview as its content source. **Next.js is retired** for the operator (`next dev`/`next start` blocked). ⚠ But `apps/operator/app/**` is **NOT** dead code — operator-vite still imports its live page implementations from there via the `@/app` alias + `next/*` compat shims (verified 2026-06-01; see plan `finish-next-removal-2026-06-01`). Only running it as a standalone Next app is retired; the actual `next/*` removal is still pending.
- `:3070` — operator harness sidecar API + internal engineering docs at `/internal/docs` (Starlight static output; only when the desktop is up).

**Implications for any agent making transport / persistence / sync decisions:**

| Concern | Desktop (production) | Browser (test/dev) |
|---|---|---|
| Sync transport | **SSE primary** (`/api/zero-harness/sse` pushes invalidate/update via PG LISTEN/NOTIFY) | Zero WS primary, SSE fallback, polling as floor |
| Persistence | embedded-pg (real PG 17 via libs/papercusp/packages/embedded-postgres-server) | Same — embedded-pg, NOT pglite |
| zero-cache process | **Not run** — operator sidecar serves SSE itself | Production zero-cache service from docker-compose.papercup.prod.yml |
| Runtime detection | `window.__TAURI_INTERNALS__` + server-side `/api/desktop/version` fingerprint | Neither present |
| Override for tests | `localStorage.harnessSyncTransport = 'SSE'` to force desktop path in browser | `'WEBSOCKETS'` to force browser path |

**Stale docs to mistrust** (cross-checked 2026-05-11):
- `libs/generic/sync/PASS_2_1_DECISION.md` (2026-05-06) declared "stop SSE" — **SUPERSEDED 2026-05-07** by the HarnessZeroProvider decision to make SSE primary on desktop. The doc has a header banner now but is otherwise frozen.
- `libs/generic/sync/src/transports/sse/SSEAdapter.tsx`'s old header claimed "no current consumer, preserved-but-frozen" — corrected to reflect production use.
- Any code comment or memory note that says "Zero WS is primary everywhere" or "SSE is dead" predates 2026-05-07 and is wrong for desktop.

**When designing new sync-touching features:** desktop SSE is the path that matters. Browser WS is a fallback that lets developers test in a normal browser. If a feature only works under WS, it's incomplete for production.

## Retired / preserved-not-active surfaces

Some code is **retired but deliberately kept** in the tree for reference — not
deleted, not deployed, not tested, and not to be extended. Agents repeatedly
mis-read these as active because they still look like workspaces, carry deploy
config, or have recent commits. **Treat everything in this list as dead:** do not
write tests for it, wire new code to it, or "revive" it without an explicit ask.

| Surface | Location | Status | Restore |
|---|---|---|---|
| `@papercup/web` — papercupai.com public site | `_retired/papercup/` | Retired 2026-05-30. Dropped from the workspace glob + root scripts; `docker-compose.papercup.prod.yml` + `Dockerfile.papercup` bannered (preserved, not deployed). | `_retired/papercup/RESTORE.md` + git tag `papercup-web-retired-2026-05-30` |
| Standalone operator webapp (`apps/operator` opened on `:3055` in a browser) | `apps/operator` — run **only** via the Tauri shell | Retired 2026-05-14; a `PreToolUse` hook blocks browsing its ports. (Old "native PG renamed `papercusp_legacy` to fail loud" rationale is stale — native `papercusp` on `:5432` is the live dev substrate; see Database-topology.) | n/a — the operator still ships, just not as a standalone webapp |
| `libs/zero-harness` — Zero ZQL schema/queries | `libs/zero-harness` | On the Zero-retirement path; the ZQL package now has **0 live importers** (only dead surfaces reference it: `libs/papercup-shared/**/*View.tsx` + the retired `@papercusp/web`). **Migrate off, don't add tests.** | n/a |
| `libs/papercup-db` — fictional-org demo schema | `libs/papercup-db` | Demo data; only consumed by `_retired/papercup` + a vendored submodule. Deletion candidate. | n/a |
| `libs/holepunch-spike` — P2P spike | `libs/holepunch-spike` | Phase-0 spike. **NOT zero-importers** — its `holepunch.d.ts` shim surface is implemented by `apps/operator/lib/sync/hyperbee/swarm.ts` and wired into ~10 orchestrator files (feature-claim, distributed-claim, instrumentation-node, …), so it is not a safe delete as-is. | n/a |
| `libs/papercup-shared/**/*View.tsx` | `libs/papercup-shared` | The read-only `*View.tsx` components render the retired web surface; the non-view helpers (e.g. `_admin-paths`) are still shared and live. | n/a |
| Legacy `@papercusp/orchestrator` run-loop (`runMainLoop` + the `pre-loop`/`synthesizer`/`actions-block`/`checkpoints(-pg)`/`snapshot-state`/`snapshots-pg`/`mission-state-pg`/`dispatches-pg`/`distributed-claim-fetch` cluster + `bin/run.ts`, plus the second-sweep leaves `git.ts`/`branch-iso.ts`) | `libs/papercusp/_retired/orchestrator-run-loop/` (+ superproject `_retired/orchestrator-run-loop/apps-operator-test/` for the 4 integration tests) | Retired 2026-06-06 (`archive-legacy-orchestrator-deadcode`). 0 live importers; superseded by the DBOS pipeline. Barrel + 4 package.json subpath exports pruned; the `cost-cap.ts`→`mission-state-pg` cross-edge severed (cost-cap is now FS-only). `lint:no-retired` guards against re-imports + a reappearing `/api/plugins/orchestrator/spawn` fetch. | `libs/papercusp/_retired/orchestrator-run-loop/RESTORE.md` + submodule git tag `legacy-orchestrator-run-loop-retired-2026-06-06` |
| `@papercupai/orchestrator-spawn` plugin (never installed) | `libs/papercusp/_retired/orchestrator-spawn-plugin/` | Retired 2026-06-06. Superseded by `fleet/operator-spawn.ts`; its `/api/plugins/orchestrator/spawn` path 404'd. | `libs/papercusp/_retired/orchestrator-spawn-plugin/RESTORE.md` |
| The harness-snapshot system (`@papercusp/export-state` FS-tarball lib + `snapshots:*` tools + `/api/snapshots/*` routes + the Cupboard `kind=snapshot` path + worker R2 blob store + the `SNAPSHOTS` flag + `snapshot_index` PG table) | `_retired/snapshot-system/` | Retired 2026-06-09 (`retire-snapshots-instance-spec`). A monolithic-era abstraction; its jobs re-homed — distribution→blueprints, backup→git+PG, reproducible clone→the lightweight `InstanceSpec` (`packages/operator-core/lib/instance-spec/`, capture/boot/vary). `@papercusp/export-state` dropped from the workspace glob + lockfile; migration 199 drops `snapshot_index`. NOT the legacy `harness_snapshots(_consolidated)` iteration-snapshot tables (still live). `lint:no-retired` guards re-imports. | `_retired/snapshot-system/RESTORE.md` + git tag `snapshot-system-retired-2026-06-09` |

**Convention for retiring-but-keeping a surface:** (1) move it under `_retired/`
— this drops it from the `apps/*` / `packages/*` workspace globs so npm, the
affected-test runner, knip, and nx stop treating it as live (the structural signal
that fools agents, not a prose note); (2) remove its root `package.json` scripts
and banner any deploy config — **preserve, don't delete**; (3) add a `RESTORE.md`
in the moved directory with the exact re-wiring steps + the last-active commit, and
cut a `git tag <name>-retired-<date>` restore point; (4) add a row to the table
above. Restoration is then `git mv _retired/<x> <orig>` + re-apply the RESTORE.md
steps.

## Borrowable libraries — generic, domain-free, reusable anywhere

A growing set of our libraries carry **zero Papercusp/Restart domain coupling** —
any project can borrow them. Where a host-specific value is needed it's injected
through a small seam (a `configure*()` call or a prop); Papercusp maps its own
domain onto that seam in the operator, so the lib itself names no consuming app.

**The catalog is `BORROWABLE.md` at the repo root** (generated — `npm run
gen:borrowable`; source of truth `scripts/gen-borrowable-catalog.mjs`). It lists
each borrowable lib with its description + repo, grouped by domain, plus a
"reusable with host wiring" section for libs that keep a Papercusp tie-in by
design (`locks`, `coordination`, `backup`, `docs-engine`, `host-platform`).
As of 2026-05-31, **every borrowable lib is its own standalone (private)
submodule under `libs/generic/*` → `github.com/Papercusp/<name>`** — the
borrowable submodules were physically regrouped there, and the borrowable
in-repo `packages/*` libs (rrf, search, memory, ipc-framing, ipc-endpoint-server,
desktop-ipc, rate-limit, plan-parser, embedded-pg-discovery) were promoted to
their own private repos. Only the kept-tie-in libs stay in `packages/` /
`libs/`. Consumers import by package name (`@papercusp/<name>`), so the
location is transparent. When you make a lib generic — or notice domain
coupling leaking into one — add/adjust it in the generator and re-run. See
`papercusp-systems-abstraction-2026-05-29`.

**Generic-first — write it in `libs/generic` from the start, don't migrate it later.**
A genuinely domain-free algorithm (a textbook concurrency / distributed-systems /
data-structure core: a supervision tree, fencing tokens, a topological sort, a
token-bucket rate limiter, φ-accrual, a saga…) **must START as `libs/generic/<name>`
behind a `configure*()`/port seam** — not written inside `packages/operator-core/lib`
to be extracted in a later pass. The 2026-06-05 audit (`generalize-libs-to-generic-2026-06-05`)
found a large batch of exactly that debt and had to migrate ~12 cores out of the app;
the discipline below stops it re-accruing:

- **`npm run lint:generic-first`** (advisory; `:all` for a full-tree sweep) flags a
  *substantial, zero-coupling* file that *names a generic CS concept* and landed in
  `operator-core/lib` / `apps/operator/lib`, and nudges it toward `libs/generic`. It's
  informational by default (like `lint:knip` — it advises, never gates), since the
  signal is a heuristic. Both signals are required on purpose: structural decoupling
  alone flags ~200 files, so the concept name is the precision filter.
- A genuinely app-local file whose concept keyword is incidental (e.g. "backpressure"
  describing browser audio buffering) goes in the `ALLOW` set in
  `scripts/check-generic-first.mjs` — don't silence the whole lint.
- The seam pattern itself: `/internal/docs/agent-insights/generalizing-a-lib-host-seam-pattern`.

## This app is in testing — there are no users yet

There is no production. **Don't defer fixes for "let's see how it fares in production first"** — there's nothing to fare in. That gives us the luxury to break things continuously until the app is right. Pick the right fix *now*; don't ship awkward compromises to preserve compatibility with a future you haven't built yet.

**Be bold — in alpha, timidity is the failure mode, not breakage.** Nothing you break can hurt a user, because there are none. So the genuine *mistakes* here are the cautious ones: preserving a design you know is wrong, adding a back-compat shim, keeping a deprecation alias, or shipping a half-fix to dodge churn. When the correct fix is a breaking change — a schema migration, an API redesign, a rename, ripping out a load-bearing-but-wrong abstraction — **make it now, in full, even if it's more work or risks breaking things elsewhere.** Breaking things now for better maintainability + expandability later is a trade we *want*; the long-run win beats the short-term breakage every time. Don't water a fix down to feel safe, and don't ask permission to do it right — just tell the user what you changed.

In practice this means:
- Redesign APIs that are wrong instead of layering on top
- Rename identifiers when the old name is confusing — don't keep deprecation aliases "for one release cycle"
- Take schema migrations now if they're correct, not when usage forces your hand
- Refactor architecture when foundational decisions are wrong, not when they're load-bearing
- Pick the *best* tool/library, not the safe one — license + compatibility are footnotes, not vetoes
- Prefer a maintained library or an existing internal surface over rolling your own; lift anything general into a shared/generic lib rather than leaving it inline

Surface what you're changing so the user knows; don't ask permission to do it well.

---

## Don't silently defer or drop scope

If something in scope is too hard/big/risky, **don't quietly set it aside.** Surface it to whoever supervises your work and get a decision before you re-scope — for an autonomous agent that's your validator/reviewer or the Queen, recorded on the work-item (`work_items:set_state` → `blocked`, with a reason) so it's durable and queryable, not a prose message that scrolls away; for a human session that's the user. Carry outstanding/deferred items forward in your status reports so they aren't lost.

> The human-session specifics — asking the user before deferring, and re-surfacing every deferred item to the user in *every* status update — live in the **PSU engineer playbook**, not here, so they don't leak into autonomous agents' prompts (EI-148).

---

## Branch discipline: **the shared tree always stays on `staging`; `main` is automation-only**

Since the staging→main cutover (`staging-branch-pipeline-2026-06-06`), the
branch model is:

- **`staging`** — the integration branch / agent firehose. The repo at
  `/home/marsh-office/papercupai-workspace/papercup` is the canonical shared
  checkout and **must always have `staging` checked out**. Other agents
  (paperclip, the operator UI, dev servers, the harness fleet) all assume
  this. Branch-switching there breaks them all.
- **`main`** — the GREEN branch. It only ever **fast-forwards** to a
  `staging` commit that passed the green-checkpoint suite (run in an
  isolated checkout). **Nothing and no one pushes `main` directly** — not
  you, not git-sync; only the green-checkpoint automation advances it. A
  fresh clone of `origin/main` is always a tested state, and the live
  `:3070` operator auto-serves it.

**Work on `staging` directly — do NOT use `git worktree` or feature
branches.** We deliberately run one shared tree rather than many
diverging worktrees: it's simpler, and it spares everyone the
merge-reconciliation tax later. The tradeoff is a messy history — your
work gets swept into other agents' commits and theirs into yours — and
that's expected and fine. Coordinate through the **lock + coord
systems**, not through tree isolation:

- **`locks:*`** claims the files you're about to edit. A `PreToolUse`
  hook does this per-edit automatically and blocks an edit when another
  agent holds the file; call `locks:acquire` by hand only for a
  multi-file change you must hold across several edits + the commit.
- **`coord:*`** announces what you're working on (`coord:declare-intent`)
  so peers see you, and carries hand-offs / messages.

Parallel agents on one `staging`, serialized by locks + coord, is how
concurrent work stays collision-free here. You don't `git commit` or
`git push` — a background **git-sync** routine owns both (see *Commit
discipline* below); just leave your work in the tree.

(Submodules are unchanged: each stays on its own default branch — git-sync
pushes them as before. The staging→main gate applies to the superproject;
`main` only advances to staging commits whose pinned submodule SHAs passed
the suite, so green `main` still always resolves to a tested combination.)

**Symptoms that you've forgotten this rule:**
- `git status` shows `On branch <not-staging>` in the shared checkout —
  switch back to `staging` immediately and recover any in-flight work via
  `git stash`.
- Paperclip starts editing files that look stale or wrong — it
  almost certainly thinks it's on a different branch than you.
- Dev/prod servers start serving 404s or HMR-error pages for routes
  that exist on disk — branch divergence between server and source.

## Commit discipline: **git-sync owns commit + push — you do neither**

A background **git-sync** routine commits the whole shared tree (every
agent's work) and merges + pushes it to **`origin/staging`** on a schedule —
the superproject **and** every submodule (each submodule to its own default
branch). So **you no longer `git add` / `git commit` / `git push`**: just
leave your work in the tree and it lands on origin automatically within a
few minutes. The per-edit file-lock hook still serializes concurrent edits
to the same file, so a peer can't stomp your uncommitted work between
ticks. Don't stash, branch, or scope pathspecs to isolate "your" diff —
there are no per-agent commits anymore; the routine packages whatever's in
the tree. An auto-merge conflict it can't take is resolved by a
`merge-resolver` agent, not you.

From `staging`, work reaches `main` automatically: **green-checkpoint**
(hourly) runs the suite on staging HEAD in an isolated checkout and
fast-forwards `main` when green; **release-trigger** (every 15 min) then
auto-deploys green `main` to the live `:3070` operator (drain → swap →
migrate → restart → health-check, auto-rollback). Your change being "in the
tree" means it reaches `origin/main` + the live host as soon as the suite
is green — and NOT before. The `/admin/git` tab shows the whole pipeline.

Pause the routine only via `UPDATE harness_shared.routines SET active=false
WHERE name='git-sync'`. Design: `git-sync-auto-commit-2026-06-03` +
`staging-branch-pipeline-2026-06-06`.

## Running the operator: `npm run dev` from `papercusp-desktop/`

`apps/operator/bin/dev` and `apps/operator/bin/prod` are **retired** as standalone entry points. The Tauri dev shell is the only supported way to bring up the operator — it spawns the same Vite SPA (`:3055`) + Hono host (`:3070`) under the hood with embedded PG attached (Next.js is retired).

```bash
cd /home/marsh-office/papercupai-workspace/papercup/papercusp-desktop
npm run dev
```

If you need to iterate on a server-side handler or API route and you don't want to wait for the Tauri webview to repaint, you can still reload the desktop window (Ctrl+R in the Tauri shell) or hit endpoints directly at `127.0.0.1:3055` and `127.0.0.1:3070` *while the desktop is running*. Do not try to start `apps/operator` on its own — it isn't a separable webapp (and a `PreToolUse` hook blocks browsing its ports). Note: the old "first PG query fails because native PG was renamed `papercusp_legacy`" rationale is stale — native `papercusp` on `:5432` is live and is this dev box's substrate (see Database-topology).

**Server-side code has no hot-reload — and on the standing dev box, a `:3070` restart does NOT pick up your edits (two-port model; staging→main auto-serve since `staging-branch-pipeline-2026-06-06`).** The **Hono host** (`bin/hono-host.ts` — the MCP tools, the `lib/endpoint-route` handlers, and everything in `apps/operator/lib/**` they import) runs under `tsx` with no file-watch. How an edit goes live depends on which host:

- **`:3070` (`papercup-dev-api`) is the GREEN/stable operator** — it runs from the separate **release checkout** (`papercupai-workspace/papercup-release`), pinned to the green **`main` branch**. Restarting it just reboots the same green snapshot; **your `staging` edits are invisible to it** until the auto-serve pipeline carries them: green-checkpoint (hourly) FFs `main` when `staging` is green, then release-trigger (≤15 min later) auto-runs `deploy-cli --execute` (drain → swap → migrate → restart → health-check, auto-rollback on failure). A manual `npx tsx apps/operator/lib/release/deploy-cli.ts --execute` still works for an immediate deploy. See `apps/operator/lib/release/README.md`.
- **`:3170` (`papercup-staging-api`) is the staging operator** — it runs from the integration tree (the `staging` branch). To test a server-side edit live: `systemctl --user restart papercup-staging-api.service`, then probe `:3170`.
- **The Tauri dev shell** spawns its own operator from the integration tree — reloading the desktop shell still picks up `staging` edits in that context.

(The `:3055` **Vite** dev server *does* hot-reload its own routes/components.) The tell that you're testing stale server code: a probe lands in the *old* place — e.g. during the coord FS→PG cutover a `coord:send` kept writing `coord/*.jsonl` instead of Postgres because the host hadn't reloaded. Probe where the write actually lands; if it's stale, restart the *right* host (or deploy) and re-probe before trusting any result.

## Read this before changing code

Performance regressions in this repo have repeatedly come from the same
small set of patterns (serial fs loops, per-slug PG-pool opens, `<details>`
gating, duplicate React keys, stale Radix pointer-events overrides, etc.).
**Read the operator docs site's performance page before any non-trivial
change**:

→ With Tauri dev running, open `localhost:3070/internal/docs/performance` (Starlight) or the in-shell docs link
→ Source: `apps/operator-docs/src/content/docs/performance.mdx`

Pay particular attention to the "What NOT to do" sections (A1–A14). If
your change matches one of those anti-patterns, change the approach
before writing the code. The audit findings (2026-05-03) at the bottom
of that page are real and were causing the dashboard's TTFB to be ~19s
on localhost.

## Storage policy: Postgres by default

**New durable state goes in Postgres unless there is a specific reason it
must be a file.** Across rounds 1-14 of the file→PG migration arc we
moved ~30 distinct surfaces (operator state, credentials, system
principals, registries, feature notes, provision state, audit log, trust
store, OAuth nonces, mobile pair tokens, rate limits, user-profile
preferences, …) from JSON files / in-memory Maps into PG. The pattern
keeps recurring: someone "temporarily" stores state in a file or a
module-local `Map`, it survives, and a later session has to migrate it
under load. Skip the cycle.

**Default: Postgres.** Storage helpers live in `apps/operator/lib/operator-state-pg.ts`
(single-row-per-workspace JSONB pattern) and various dedicated modules
for compound-key tables. Add a column to an existing table or write a
migration in `libs/papercusp/libs/db/sql/<NNN>-...sql`.

**Schema = migrations only; NO runtime DDL.** The `harness_shared`/`papercup_shared`
schema is defined entirely by migrations — one squashed `000-baseline.sql` + incrementals
from `107+`. The old `ensure-schema.ts` lazy-`CREATE TABLE` pattern is **removed** (plan
`self-contained-migration-baseline-2026-06-02`). To change the schema, **add a migration**
(idempotent; ≥ `107`) — never an `ensureXxx()` / inline `CREATE TABLE` in runtime code —
then `node libs/papercusp/libs/db/scripts/pull-schema.mjs`. `000-baseline.sql` is a frozen
generated dump (don't hand-edit). `empty → head` is gated by the strict
`fresh-migrate.integration.test.ts` + `lib/db-tools/verify-baseline.ts` (zero skip-tolerance).
Full guide: `/internal/docs/system/storage-policy`.

**Two axes — runtime store-of-record vs sync authority.** Harness state separates
*where the operator reads/writes locally* (the **runtime store-of-record** = PG,
uniformly) from *how a shared table merges/propagates across machines* (the **sync
authority** = `none`/`git`/`peer-log`). **Never write bare "canonical" — name the
axis.** Per `harness-state-storage-unification-2026-06-01` (D-002): PG is the
runtime store-of-record for every harness table; git stays the *sync authority* for
document tables (dogfood D-001/D-020 intact). Full spec:
`/internal/docs/system/storage-policy` (`system/storage-policy.mdx`).

### Database topology — embedded-pg is the ship target; this dev box runs native PG

The **shipping** product is a desktop app backed by **embedded Postgres**
(`embedded-postgres-server`, per-harness instance), discovered through
`~/.papercusp/embedded-pg.json`. That remains the product direction, and code
must keep working under it (see the implications below).

**Reality on the standing dev box (verified 2026-06-01): the operator runs
against NATIVE Postgres `papercusp` on `localhost:5432`, not embedded-pg.**
`apps/operator/.env.local` pins
`DATABASE_URL=postgresql://harness_admin:…@localhost:5432/papercusp`, the `:5432`
cluster holds the live databases `papercusp` (operator), `papercusp_su`, and
`papercusp_test`, and **no embedded-pg is running** here. So the earlier claim
that "native `papercusp` was renamed to `papercusp_legacy` and connecting to
`localhost:5432/papercusp` fails immediately with `database "papercusp" does not
exist`" is **stale/false** — there is no `papercusp_legacy`, that connection
works, and it is what the dev box uses. A few one-liners elsewhere in this file
still repeat the old "renamed to legacy / fails loud" line (the standalone-webapp
retirement is still real; only that *mechanism* is wrong) — **this section
supersedes them.**

Practical rule: **never hardcode `localhost:5432`** regardless. Resolve the admin
DSN through `getHarnessAdminUrl()` so a code path works whether the box is on
embedded-pg (discovery file) or the native-PG `DATABASE_URL` override — hardcoding
ties you to one box's topology.

Practical implications when writing code today:

- **SQL migrations** in `libs/papercusp/libs/db/sql/<NNN>-*.sql` are
  applied automatically by the embedded-pg boot runner
  (`libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js`,
  added 2026-05-05). For native PG you still apply manually with
  `psql -f` — but **don't write code that depends on the manual step
  having happened**; embedded-pg is the source of truth, and the
  schema must work there. The manual `psql -f` is a dev-only chore,
  not an architectural requirement.
- **Don't add features that only make sense against native PG**
  (cross-database queries, `pg_extension` not available in
  embedded-pg, OS-level pg tooling). If embedded-pg can't run it, the
  product can't ship it.
- **Connection-string assumptions:** prefer the workspace-resolved PG
  connection that the embedded-pg path returns; don't hard-code
  `localhost:5432`.
- **Migration runner:** embedded-pg applies `sql/<NNN>-*.sql` automatically
  on boot; native `:5432` has **no** auto-runner, so on this dev box you apply
  pending migrations manually (`psql "$DATABASE_URL" -f <file>`). Embedded-pg is
  still the ship target, so the schema must work there too — but "system PG is
  going away" is **not** true today: the dev box runs on native `:5432` (see the
  topology note above), so don't write code that assumes embedded-pg is the only
  reachable substrate.

**Acceptable file uses (the short list):**
- Bootstrap state that must be readable before a PG connection exists
  (`~/.papercusp-workspaces/registry.json`, `db-encryption-key`).
- Postgres's own data files (`pglite-data/`, `embedded-pg-data/`).
- Code, scripts, templates, snapshots — files that ARE the spec.
- Harness contract artifacts in `<harness>/.papercusp/*` — read by tools
  running inside the harness; the file IS the contract surface.
- Append-only logs at high volume (`.papercusp/action-runs/<run>.log`)
  where SQL log tables would dwarf the actual state.
- Per-process locks via O_EXCL semantics (legitimate FS atomicity).
- Plugin-sandbox storage (the plugin host exposes a virtual FS to plugins
  by design).

**NOT acceptable:**
- Plain JSON state files for app-level data the operator reads/writes.
- Module-scoped `Map`s holding TTL'd auth/session/rate-limit state.
- localStorage that should sync across devices (per-user preferences).
- "PG mirror" patterns where the file is primary and PG is best-effort —
  the file always drifts ahead. Either go full PG or document a real
  reason the file must be authoritative.

If you find yourself reaching for `fs.writeFileSync('something.json')`,
ask whether you can put it in PG instead. The answer is almost always
yes. See `apps/operator-docs/src/content/docs/system/storage-policy.mdx` for the
full guide and the historical migration arc.

## Feature flags + PostHog

V1 ships with a feature-flag system that gates the 9 cut-for-V1 surfaces
(snapshots, templates, marketplace, cloudflare-publish, oracle, harness
phases, design, rust-port-ui, admin). Single source of truth for keys
and defaults is `libs/flags/src/types.ts`. Self-hosted PostHog runs at
`https://flags.papercuspai.com` for live evaluation; the operator falls
back to bundled `FLAG_DEFAULTS` (all `false` = V1 ship state) when the
discovery file (`~/.papercusp/posthog.json`) is missing or
`testingFeatures: false`.

**Flip flags via the in-app `/admin/features` page**, not by editing
JSON or hitting PostHog directly. The admin UI calls
`POST /api/flags/set` and `POST /api/flags/preset` which round-trip
through PostHog + the SSE flag-bus.

**When adding a feature you'll later want to cut**, gate it from day one:
add the flag to `libs/flags/src/types.ts`, create the matching definition
in PostHog (active=false, rollout 0), then guard pages with `requireFlag`,
nav with `useFlag`, API routes with `gateApiRoute`, Hono routes with a
`use('/path/*', …)` middleware, and MCP tools at registration.

Full reference: `/internal/docs/posthog` and `/internal/docs/posthog/feature-flags`.

## Tests after editing

After completing any file edit, run the affected tests **before** declaring
the task done:

```bash
npm run test:affected                  # unit only — fast, default
npm run test:affected:integration      # also runs *.integration.test.ts
```

The walker (`scripts/affected-tests.mjs`) diffs against `origin/main`,
maps changed files to npm workspaces, computes the reverse-dependency
closure, and runs every affected workspace's `test` (and optionally
`test:integration`) script.

If your edit touches:

- `libs/papercusp/libs/db/**` (Drizzle schema / migrations) → run
  `npm run test:all:integration` — schema changes affect every
  workspace and the dependency graph won't catch them.
- `libs/papercup-shared/**` → already covered by the walker.
- `infra/**` or `Procfile*` → no automated coverage; manually verify.

Do **not** run `npm run test:all` for routine edits — it's slow and
produces noise. Use it only for pre-merge sanity checks or schema
changes.

## Browser checks — use `verdict`

For **ad-hoc / exploratory** browser verification during development
(clicks, fills, screenshots, CSS inspection, accessibility), use the
`verdict` skill, **not** the Playwright MCP tools and **not** ad-hoc
Puppeteer scripts.

This is distinct from the committed, CI-run browser-E2E suite at
`apps/operator/e2e/*.spec.ts` (26 Playwright specs) — that suite **is**
maintained and is the automated browser-E2E framework (see the "four
canonical frameworks" section below). The rule governs *how you do an
interactive check*: reach for `verdict`, and use Playwright only to run
or extend those existing `*.spec.ts` files. See per-project `TESTING.md`
for what's covered.

`verdict` is for **arbitrary/external** pages. The **operator UI**
(`:3055`/`:3070`) renders correctly only inside the **Tauri shell** — so
verify operator/app behavior there via `tauri-agent-tools` per
`/internal/docs/testing/agent-e2e`, **not** by pointing `verdict` at those
ports (see the run/testing rule at the top of this file).

## Per-project TESTING.md

Each app and lib ships a `TESTING.md` at its root listing what its
tests cover, what they don't, and what to run after editing. Read
the relevant project's `TESTING.md` before adding tests so you match
the existing pattern.

## Test infrastructure

- Test runner: **Vitest 4** (all layers).
- Shared config: `@papercusp/test-config` exports `defineVitestConfig`,
  `getTestPg` / `withTestSchema` (testcontainers-node Postgres), and
  `setupMsw` / `msw`.
- Integration tests get a per-file Postgres schema (`t_<hex>`) on a
  reused `postgres:16-alpine` testcontainer.
- **Docker must be running locally** for integration tests. Run
  `npm run test:doctor` to verify your environment.

## CI

- Per-PR: `.github/workflows/test.yml` runs the affected unit +
  integration suites; results posted as a PR comment via JUnit.
- Nightly: `.github/workflows/test-nightly.yml` runs everything.

## Property-based tests

Use `fast-check` for invariant-style tests where examples undercount —
encoders/decoders, slug rewrites, hash canonicalisation, validator
predicates. Pattern: `<source>.property.test.ts` colocated with source.
See `libs/papercup-shared/src/_admin-paths.property.test.ts` for a
worked example.

## Dead-code / unused-export checks (knip)

```bash
npm run lint:knip       # report
npm run lint:knip:fix   # auto-remove obvious unused imports
```

Knip runs in CI **informationally** — its output never gates a merge.
Treat its findings as a discussion input. False positives (Next.js
dynamic chunks, fonts, CSS-only consumed packages) live in
`knip.json`'s `ignoreDependencies` allow-list.

## Flaky-test quarantine

Tests known to flake live in `quarantine.txt` at the repo root, one
entry per line as `<workspace-name>::<file>`. Quarantined workspaces
still run in CI but their failures don't gate the merge — the walker
prints a `[QUARANTINED]` marker and a non-gating warning.

A PR that touches a quarantined test's source must either de-quarantine
the test (remove the line) or document why it stays. Do not silently
skip flakes.

## Test secrets

API keys for tests use the `TEST_<SERVICE>_KEY` naming convention,
stored in GH Actions repository secrets and surfaced as env vars in
the workflows. Do **not** check live keys into fixtures.

## Use Context7 for current library docs

Before using non-trivial APIs from third-party libraries (Vditor,
BlockNote, mind-elixir, Excalidraw, Tauri 2, Next.js 15, nuqs, Zero,
Hono, Radix, Vercel AI SDK, etc.), call the `context7` MCP tools
(`resolve-library-id` then `get-library-docs`) to fetch the current
API surface. Library APIs change faster than training cutoffs; do not
guess method names from memory.

## Adding a tool — the per-role guidance discipline

Every tool exposed via MCP is authored once in a `defineTool({ ... })`
call (or plugin manifest entry). When you ship a new tool:

1. **Define the tool** in `packages/operator-core/lib/agent-tools/<group>/<verb>.ts`
   (or `packages/agent-mcp/src/tools/...` for read-side tools).
2. **Add `import './<group>/<verb>';`** to `packages/operator-core/lib/agent-tools/index.ts`.
3. **Add `guidance: { when, notWhen?, chaining?, byRole? }`** to the `defineTool` call. `when` is the most important field — author it first.
4. **If exposed on a chat surface**: add `mcp__agentmcp__<group>:<verb>` to that surface's `allowedTools` array (operator-converse: `packages/operator-core/lib/operator-mcp-tools.ts`; oracle: `packages/operator-core/lib/agent-tools/oracle/prompts.ts`).
5. **Run** the Vitest sync test `packages/operator-core/lib/__tests__/tools-md-sync.test.ts` (e.g. `cd packages/operator-core && npx vitest run tools-md-sync`) — must be green before commit.

The CI test validates:
- Every tool in the role's surface has `guidance.when` (warn-only through Phase 4; fail after Phase 5 backfill lands).
- Every backtick-wrapped `tool:name` mentioned in `<role>.tools.md` is in the role's allowed surface.
- Every `byRole.<role>` key references a known role.

Per-tool when/not-when goes in the tool file. Cross-tool patterns
(chaining, panel verbs, workflows) go in `<role>.tools.md`. Behavior
rules ("always call", "tier-high → confirm") go in `<role>.persona.md`.
The split is intentional — see `packages/operator-core/lib/prompt-assembly.ts`.

## Where new tests go — four canonical frameworks (2026-05-24)

Per `admin-testing-tab-restructure-2026-05-24` D-006, every new test
goes in **exactly one** of:

- **Vitest** `<package>/lib/**/<name>.test.ts` — unit/integration/non-browser E2E
- **Playwright** `apps/operator/e2e/<name>.spec.ts` — browser-driven E2E
- **Cargo** `#[cfg(test)] mod tests { … }` — Rust
- **LLM scenarios** `apps/operator/lib/llm-testing/scenarios/<role>/` — judge-scored prompts

**Never** create new `.mjs` integration scripts under
`apps/operator/__tests__/integration/` or tsx smoke scripts under
`apps/operator/scripts/`. CI lint (P-038) fails the build on additions.
Drop files into the conventional path and `/admin/testing` (+ the `/adv`
Tests tab) picks them up automatically via the registry glob walk — the
domain globs are directory/prefix-level, so a new test in an existing
area needs no registry edit.

**`npm run lint:tests` is a coverage guard**: it fails if any canonical
test matches no registry glob (i.e. would be invisible in the tab). If it
fires for a brand-new subsystem, widen a domain (or add one) in
`apps/operator/lib/testing-domains-registry.ts`, then **`npm run
gen:contract`** to regenerate `.papercusp/testing-domains.json` (the `/adv`
tab's contract — generated from the registry, never hand-edited;
`gen:contract:check` gates it in CI). Live smokes that need a running
operator are surfaced as `node`/`shell` runners on a domain section, not
forced into Vitest.

See `apps/operator-docs/src/content/docs/testing/index.mdx` §1.0a for
the full convention and `apps/operator/lib/testing-domains-registry.ts`
for which globs each `/admin/testing` subtab discovers.
