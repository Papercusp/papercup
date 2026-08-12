<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->
<!-- Projected from Postgres: harness_shared.harness_doc_parts (doc_id=claude-md, client=claude). -->

> ⚠ **CLAUDE.md is GENERATED — editing it here does nothing durable.** Claude Code reads this file
> off disk, which is the only reason it exists (the canonical content is in Postgres:
> `harness_shared.harness_doc_parts`, with `harness_docs.content_mode='composed'`). A hand-edit
> is overwritten by the next projection and is invisible to every other client.
>
> **To change a rule:** edit its PART, then re-project with
> `node scripts/project-doc-parts.mjs --write`.
>
> Supporting evidence for these rules is deliberately NOT here — it lives in the corpus
> (`kind='prose'` rows, searchable) so a rule reaches the agent without its case history.

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
short scalar (`"review:<id>"`) + `useMemo` lookup, never 1KB of JSON. 

## All client data sync goes through `@papercusp/sync`

Reads via `useSyncQuery({ queryName, args })`; writes fire
`notifySyncInvalidate(...)` (+ `useSyncMutate` for the hook). **Never** hand-roll
`fetch + setInterval`, SWR, React-Query, or a raw `EventSource` for query data —
the library is the one audited path (**SSE in every runtime** — desktop *and*
browser, no runtime branch; POLLING/REST only as the degraded fallback. 

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

## Spawning: no unenrolled `detached` spawn, and never kill by name

The process analogue of the scheduler rule above. A `detached: true` spawn creates a
process meant to **outlive the call that made it** — the root of a subtree — so it must be
enrolled in the task ledger: **`managedSpawn`** (`task-manager/managed-spawn.ts`) for an
async seam, **`beginSyncEnrolment` + `completeSyncEnrolment` + `finishSyncEnrolment`**
(`task-manager/enroll-sync.ts`) for a sync one. `lint:no-unenrolled-spawn` fails a new
un-enrolled site; genuinely-not-ours lifetimes (a human terminal window, a pre-operator
bootstrap, a release cut that survives the restart it performs) go in that guard's
ALLOWLIST **with a reason**. Ordinary short-lived spawns need nothing — cgroup membership
is inherited, so a `git rev-parse` inside an already-confined process is already accounted
for. That inheritance is the whole design: confine the ROOTS, and the kernel accounts for
every descendant, including ones that double-fork and reparent to init.

⛔ **Never kill by name or pattern.** `pkill -f '<binary>'` has twice killed the owner's
live desktop window and peer agents' Xvfb instances. Use **`processes:kill { taskId }`** —
it kills the whole cgroup subtree and cannot reach a recycled pid (PID wrap happens ~daily
here under fleet load). An `identity_mismatch` refusal is the rail working, not a bug. To
relieve pressure without losing work, **`processes:freeze`** beats killing.

| you want | use | not |
|---|---|---|
| what is running AND WHY (who launched it, for which work-item, what it costs) | `processes:list` | `ps`/`pgrep` — kernel-shaped, zero provenance |
| the six tracked AGENT process kinds | `dev:processes` (unchanged, deliberately narrow) | `processes:list` |
| a real whole-host process list | plain `ps`/`pgrep` (never gated) | `processes:list` — it will answer wrong, not empty |

Human pane: `/admin/tasks` (sibling of `/admin/schedules` — that one inventories everything
RECURRING, this one everything RUNNING). Full model:
[the task manager and the no-escape property](/internal/docs/agent-insights/task-manager-and-the-no-escape-property).

## Shared-lib singletons: pin through the primitive, never by hand

Module-scoped mutable state in a shared package (`const registry = new Map()`, a cache,
a pool, a `configure*()` host-seam object) is a singleton **only if the loader produces
exactly one module record**. Several ordinary seams break that with no error: tsx's CJS
preflight beside the ESM loader, the same file reached by bare specifier and by relative
path, `node_modules/@papercusp/*` symlinked into the repo, a bundled copy beside source.
When it splits, each record gets its own state and writes to one are invisible to readers
of the other. Nothing throws — you get a *partial* view that looks complete.

**Use `pinModuleState` from `@papercusp/module-singleton`, at module scope, once:**

```ts
const state = pinModuleState('@papercusp/your-pkg.state', () => ({ registry: new Map() }));
```

It pins to `globalThis` under a `Symbol.for` key — correct under *every* seam above, so
you never have to prove which one applies — and counts evaluations, so a re-split is
reported by `listModuleDuplications()` instead of being rediscovered the expensive way.
⚠ **Do not hand-roll the `Symbol.for` + `globalThis` pair.** Hand-rolling still fixes
correctness, but the key is invisible to the central report, which then answers a
confident `[]` while your module is split — the failure below, one level up.
**`npm run lint:no-hand-rolled-module-pin` fails on a new one** (and
`-- --list` prints the full measured population, which is how its allowlist is
re-seeded — never from a hand-run grep).

## Deployment model: desktop is the product; the standalone webapp is RETIRED

Shipping target = the Tauri desktop app; **SSE is the sync path that matters** —
`HarnessSyncProvider` passes a literal `syncType="SSE"` with **no** runtime
branch, so a plain browser tab runs the SAME transport as production. WS is
**retired** (nothing selects it); POLLING is the degraded fallback and is
catastrophic here (~40 registered queries re-fetched per tick against a
6-connection-per-host cap starves the pool), so a feature that only works under
POLLING — or that assumes the retired Zero WS — is incomplete. Source of truth:
`apps/operator/providers/HarnessSyncProvider.tsx`. Transport table +
stale-docs-to-mistrust list:
[repo-conventions § deployment model](/internal/docs/system/repo-conventions).

## Retired / preserved-not-active surfaces

Some code is **retired but deliberately kept** — not deleted, not deployed, not
tested, not to be extended. 

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

Interactive (human-present) PSU sessions can still take a fast redirect from the owner, but the default is resolve-don't-relay.

## A cross-lane ruling is a plan Decision, recorded the moment it forms

Any agent — not only a fleet leader — who settles a trade-off, ratifies a scope, or issues a
ruling OTHER lanes must follow records it as a plan Decision **at the moment it forms**:
`plans:add-decision { slug, title, body }` (via the structured `### D-NNN` form the tool
produces — a hand-authored `- **D-NNN**` bullet in a plan body is NOT parsed as a decision by
`@papercusp/plan-parser`, so it never surfaces through the mechanisms below). Never record a
governing ruling only as a coord message: a message is not addressable after delivery, so a
peer who received a wrong paraphrase has no way back to the source. A decision is.

This is not a paperwork nicety — it changes outcomes. 

## Every plan ships with a graded acceptance rubric

**Every plan ships with a GRADED acceptance rubric — authored AFTER implementation, before the plan is marked shipped** (acceptance-rubrics-on-every-plan-2026-08-11; flag `ACCEPTANCE_RUBRIC_COMPLETION_GATE`, default ON). `plans:set-plan-status → 'shipped'` (and its `done` alias) REFUSES without one. Once your implementation is verified:

1. `rubrics:propose { rubricRef:'<acceptance-rubric-slug>', kind:'acceptance', subjectPlan:'<plan-slug>', classRef:'plan-class-feature-ship'|'plan-class-bugfix'|'plan-class-migration'|'plan-class-investigation', characteristic:'<umbrella-domain>', title:'<acceptance-rubric-title>', criteria:[3–7 OUTCOME criteria tracing to the plan's goal + Decisions — never a restatement of the diff] }` — it activates immediately (no ratification) and stays hidden from the standard rubrics library reads (`kind` filter). An investigation-only plan may pass `criteria: []` with `classRef:'plan-class-investigation'`.
2. A NON-implementer grades it: `scorecards:emit { rubricRef, ratings }` with concrete evidence per rating — grader ≠ rubric author; a self-grade never satisfies the gate.
3. Ship. The acceptance rubric is auto-retired with its plan.

Do NOT author the rubric at plan-creation time and do NOT maintain it during implementation — it does not exist until the work is done (owner-ruled: post-implementation authoring is better informed and wastes no tokens on drifted designs). Rubric-template plans and scheduled template instances are exempt.

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

> ⚠ **Neither `git blame` NOR a commit's SUBJECT is evidence about a change in this
> repo — never cite either, least of all in an escalation.** git-sync sweeps the WHOLE
> tree on a schedule, commits it under ONE identity, and labels it with whatever
> agent/plan context happened to be current. So blame names the wrong person, and the
> subject describes the sweeping agent's INTENT, not the diff. Both are false-positive
> generators, not dead ends.
>
> **Which commit carries your change → `TZ=UTC git log -1 --format='%cI %H %s' -- <path>`.
> NOT `git rev-parse HEAD`:** the tip is routinely a DIFFERENT commit from the same
> sweep, so quoting it attributes your work to a stranger's diff. Git otherwise renders
> `%ad`/`%cd` in the machine's local timezone (`-0400` here), while Papercusp timestamps
> are UTC; use the explicit offset in `%cI` or keep `TZ=UTC` for `--since`/`--until` too.
> Whether a sha someone cites really carries a change → `git show --stat <sha>`, or grep
> the file. For live/deployed status, use `dev:pipeline_position { path }`, whose
> timestamps are UTC. For authorship, use the commissioning work-item/plan-item or a
> timestamp-correlated `sessions:search`; if neither resolves, say "not attributable" —
> never name a person.

> 🚨 **NEVER run a tree-wide destructive git op on the shared checkout** — not
> `git reset --hard`, not `git checkout .` / `git checkout -- :/`, not
> `git clean -fd`, not `git stash`. 

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

**"Is my change live, and if not what is the ONE thing blocking it" is ONE call — `dev:pipeline_position { path }` — never a hand-diff.** It answers three *different* questions that agents routinely conflate:

| you want to know | read | not |
|---|---|---|
| is it live, and if not the ONE lever | `blockedOn` + `nextAction` (the `summary` now LEADS with them) | the row of position ticks — a boolean per stage cannot say whether that stage is *moving* |
| is this leg stuck, or just slow | `stages[].health` (`advancing`/`stalled`/`disabled`/`broken`) | `positions.*` alone — that read a 2h52m push freeze as "not yet" |
| did my work reach origin | `gitSync.pushedRepos` | `gitSync.status` — `'synced'` is reachable with **nothing** pushed |
| is the running process executing my code | `serving.startedSinceCodeChange` | `positions.deployed` — a git fact stating a process conclusion ("deployed ✓" ≠ live; filed 4× independently) |
| is the gate judging MY code | `changeInCandidate.judgingContainsPath` — but ONLY trust a `true`, and read `missingReason` before believing a `false` (see below) | assuming a red is about your change — a run judging a candidate without it isn't |
| will the next tick commit my half-finished refactor | `sweepExposure` (blast radius + when) | nothing — git-sync sweeps the WHOLE tree, so `git-sync:run` mid-refactor commits the broken intermediate on purpose |

`nextAction: null` is a **positive** answer ("waiting is correct"), never a missing one —
do not invent a lever when the honest move is to wait. Full field-by-field guide:
[reading pipeline state](/internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction).

**About to ACT on one of these values — or quote it into a message, a plan, or a
work-item? RE-READ it, don't copy it: `state:read { cell }`.** These same values are
registered CELLS off the *same* resolver (`gitPipelinePosition()`), so this is a
re-read, never a second source of truth: `gate.greenCheckpoint.candidate` ·
`gate.greenCheckpoint.verdict` · `gate.greenCheckpoint.ownership` ·
`git.mainBehindStaging` · `git.pipelinePosition` · `deploy.3070.sha` (omit `cell` to
list them). Every one is a value that changes under
you mid-turn, and a transcribed copy of one is how a correct observation becomes a
confidently wrong report an hour later.

✅ **You do not have to look any of that up — `dev:pipeline_position` HANDS YOU THE
HANDLE.** Its result carries a `plane` block: one entry per volatile value, naming the
`path` it sits at in that very payload, the `cell` that re-answers it, and a ready
`reread` call. Copy the handle, not the number. Two things to actually read there:

- **The handle is already addressed to YOUR subject.** `git.pipelinePosition` and
  `gate.greenCheckpoint.candidate` are per-path cells, so their entries carry
  `as: '<the path you asked about>'`. Re-reading either WITHOUT that `as` answers about
  a different subject — which is why a no-arg call emits `unreadable: { needs: 'path' }`
  for those two and no handle at all, rather than one that looks authoritative and
  resolves elsewhere.
- **An entry appears even when the value is `null`.** That is deliberate: a null
  deployed-sha or candidate is the reading you are *least* entitled to transcribe, so
  it is the one that most needs a handle.

The block is derived from each cell's own `changeSignal` declaration, so it cannot drift from the registry — a cell added, renamed or re-pathed shows up (or stops showing up) on its own (`state-plane-stamp.ts`).

Two specifics worth knowing:

- **"Is the gate red about MY change?"** — `state:read { cell:
  'gate.greenCheckpoint.candidate', as: '<your path>' }`. It is per-path on purpose, and
  its falsifier is a **blob containment** check against the candidate — the same
  primary method the long recipe below prescribes, run for you. Its stated job is to
  kill exactly one error: *"the gate is red" read as "the gate is red ABOUT MY
  CHANGE."* That error, not the red itself, is what repeatedly costs hours here.
- **Waiting for one to CHANGE** (a verdict, a deploy sha) → `state:subscribe`, not a
  poll loop and not a hand-built await.

✅ **It DOES answer *"which sha is the run judging right now"*, AND it now names its own
provenance — read `source.authoritative` before you act on the sha.** The cell returns
`source: { value, authoritative, why }`: `'retriage-marker'` is authoritative (the run's OWN
published `inFlightRetriage` marker — an observation of what it is judging), `'run-probe'` is
NOT (on a MANUAL run its `/tmp` unit log, but on a CRON run it degrades to the checkpoint
checkout's live HEAD, an inference that changes between two reads). A non-authoritative
reading is also hoisted into the reply's `summary`, so you cannot miss it. Do not fire a
manual re-run off an inferred candidate. Raw `harness_shared.routines` SQL is the LAST resort.

⚠⚠ **THE PREMISE UNDER EVERY RECIPE BELOW: the candidate is cut from your LOCAL `staging`,
NOT from `origin/staging`. The gate never fetches — so PUSHING IS NOT A GATE PRECONDITION.**

`green-checkpoint.ts:3466-3468` resolves it as `revParse(cfg.integrationRoot,
cfg.integrationBranch)`, and `integrationBranch` defaults to the literal `'staging'`
(`release-config.ts:131-132`). There is no `git fetch` anywhere in that file's 6,950 lines, and
its only three `origin/` mentions are prose about GitHub Actions' `origin/main` base-ref default
(two comments and one log string) — none resolves a candidate. The CLI path (`:6792`, `:6802`) cuts the same way. So the
hop that matters for containment is **COMMIT** (git-sync's local commit); the push to origin is
a separate, later concern that no containment test below depends on.

Get this wrong and every recipe below still *runs*, but answers about the wrong object: an
unpushed commit reads as "not in the candidate", the push leg looks like the thing blocking you,
and the natural next move is either to wait for a push that was never blocking or to fire a
manual `release:checkpoint-run` that **discards a live auto-refire rescue** and costs a ~55min
suite.

**Corroboration requires independent EVIDENCE, not independent recall.** Two agents agreeing is not confirmation when both merely inherited the same unstated convention. The claim in this box is pinned to the code by `packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts`, so a gate that legitimately starts reading a remote ref fails there and forces this text to be updated with it.

⚠⚠ **STEP 0 FIRST — establish WHICH sha is actually being judged. Skipping this is the
expensive mistake, and no amount of care in the steps below can recover from it.**

✅ **ONE CALL ANSWERS STEP 0 AND STEP 1 TOGETHER — do this before you write any SQL:**

```
state:read { cell: 'gate.greenCheckpoint.candidate', as: '<your repo-relative path>' }
```

It returns the judged sha (`changeInCandidate.judgingSha` — marker-preferred since WI-36259, see above), **its provenance (`source.authoritative` — check this before acting)**, the containment falsifier `judgingContainsPath` (*is the gate judging MY change*) with its own prose attached, a `verdictUnknown` hoist naming anything it could NOT determine, and the `resolver` that produced them. The cells and the doors read the SAME resolver (`gitPipelinePosition()`), so this is a re-read of the authority, never a second source of truth. **Everything below — the marker SQL, the log greps, the ancestry and blob archaeology — is the FALLBACK**: reach for it when the cell answers `unknown`, when `source.authoritative` is false and the distinction matters, or when you need a field the cell does not carry (the refire budget, a run's failing-file set).

🚨 **Never fire a manual `release:checkpoint-run` while a run is in its re-triage window.** That
window is where a STALE red gets voided and the gate re-fires itself onto a newer tip;
`green-checkpoint.ts:2566` states plainly that killing it "discards the rescue and costs a full
suite". 

✅ **You no longer have to remember to check — the verb itself now refuses with the answer.** `release:checkpoint-run`'s `already_running` reply reads the marker and, when a refire is in flight for THAT run, leads its `note` with `🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN`, names both candidates (the one being judged **and** the one already discarded), lists the files the abandoned red named so you don't go fix them, and reports the budget via `in_flight_retriage.budget`/`at_cap`. Its containment check switches to the marker's candidate too, so `callerEditsInCandidate` answers about the sha actually being judged rather than the checkout HEAD inference. A marker written BEFORE that run started is deliberately NOT attributed to it (the run-lock is a singleton, so it belongs to an earlier run) and the pre-existing refusal is returned unchanged — `in_flight_retriage: null` means "no refire in flight", never "unknown".

⚠ And when it does re-fire: **a passing affected-tests suite is NOT a green gate.** The lint/perf/
desktop/delta gates and the `main` fast-forward still have to clear; an agent asserted "gate green"
off the suite result that same morning and had to retract it.

## Server-side edits and the two-port model — no hot-reload

The Hono host (`bin/hono-host.ts`, MCP tools, `lib/endpoint-route`,
`apps/operator/lib/**`) has **no file-watch**, and on the dev box a `:3070`
restart does **NOT** pick up your edits:

- **`:3070`** = GREEN operator, runs from the **release checkout**
  (`papercup-release`, `main`). 

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

- **Schema = migrations only; NO runtime DDL.** ⚠ **Pick the migration number via the atomic allocator — NEVER `ls sql/ | tail` by eye.** On this heavily-parallel fleet, two agents racing an `ls`-then-write gap WILL pick the same NNN. Run `node scripts/next-migration.mjs --name <slug> --intent "..."` (or `npm run db:next-migration --`) FIRST — it reserves the number atomically under an advisory lock (`harness_shared.migration_reservations`) and prints a `.DRAFT`-suffixed path to write. **Write + iterate at that `.DRAFT` path, not the bare `.sql` name**: the runner only ever applies files matching `*.sql` (same mechanism as the pre-existing `NNN-*.sql.PENDING-CODE-DEPLOY` idiom), so a `.DRAFT` file is invisible to boot auto-apply / `db:migrate` / the green-checkpoint preflight while you edit it — including a deliberate temporary both-ways guard-test mutation, which otherwise races the operator's auto-apply and can execute half-finished SQL against the live DB. Once it's finished and tested, ARM it with the tool's printed `arm_command` (`mv <path>.DRAFT <path>`) at `libs/papercusp/libs/db/sql/<NNN>-…sql` (≥107), and run `node libs/papercusp/libs/db/scripts/pull-schema.mjs`. Never an `ensureXxx()` / inline `CREATE TABLE`. `000-baseline.sql` is frozen/generated.
- **Never hardcode `localhost:5432`** — resolve via `getHarnessAdminUrl()`. Embedded-pg is the ship target; the dev box runs native PG on `:5432`.
- **Reading PG-canonical state? Query PG — don't dump-and-jq a projection.** Plans, work-items, issues, observations (`engineer_issues`), `tool_invocations`, scorecards, recipes live in Postgres; the `*:list` tools and `docs/plans/*.md` files are *projections*. `dev:pg_query` is for **genuinely ad-hoc / analytic** reads (a one-off group-by, join, or recency slice you won't run repeatedly). A HOT read with a stable shape belongs behind a TOOL that wraps the canonical SQL so it can't drift — e.g. "what's claimable" is `work_items:claimable`, NOT a raw floor query (see the claimability note below). **Before you write `SELECT`, check this table** — these are the reads agents most often hand-write, and each already has a tool that scopes + applies the real semantics for you:

  | you want | use | not |
  |---|---|---|
  | what issue-family work is claimable now | `work_items:claimable { harness }` | `WHERE status='open'` / the `work_items_claimable` view (overcounts ~13×) |
  | a filtered work-item / issue slice | `work_items:list` (server-side filters) | a hand-written `harness_shared.work_items` query |
  | what plans exist / the recent ones | `plans:list { updatedSince, createdSince, order, limit }` — `order` is `'updated'\|'created'\|'slug'` (NOT `'recent'` — that value is `invalid_input`; use `order:'updated'` for "the N most-recent plans") | a hand-written `harness_shared.harness_plans` query |
  | plan COUNTS (by status / harness / day) | `plans:list { groupBy, aggregateOnly }` | a hand-written `GROUP BY` over `harness_plans` |
  | pickable plan items across plans | `plans:items { actionable: true }` | unnesting the items jsonb |
  | prose / full-text | `search:fulltext` · `search:semantic` | `ILIKE '%…%'` |
  | code graph / call sites | `gitnexus.query` (dot, not colon — a plugin-namespaced MCP tool, not the usual `server:verb` form) | a hand-walk of the tree, or raw `grep -r`/`rg` over source (grep gives file/line matches; gitnexus.query gives call chains + callers/callees) |

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
>
> ⚠ ToolSearch finding NOTHING for a `use` tool does not mean it is unavailable to you —
> a trimmed surface (su) exposes only a seed of the ~550-tool catalog, so the exact
> `select:` name and a keyword search can both come back empty for a tool that exists.
> `tools:invoke { name: "<server:verb>", args: {…} }` dispatches ANY catalog tool
> server-side, gated identically to a direct call. Verified end-to-end for `testing:run`
> (EI-19463947683316510). Reach for that before falling back to the `not` column.

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
| to find where a symbol is DEFINED (and who calls it) | `gitnexus.context { name: "managedSetInterval", kind: "Function" }` | `grep -rn "export function managedSetInterval" --include=*.ts libs packages` (grep gives one matching line; the graph gives the definition plus callers/callees). ⚠ the index is refreshed by hand (`npx gitnexus analyze`) so it can lag new code; exhaustive exact-text search is still grep's job |
| to install dependencies in this shared tree | `npm run install:safe` (or `npm run install:safe -- ci` / `-- install --legacy-peer-deps`) — serializes concurrent agents behind an fs-mutex, then verifies every declared dep actually landed on disk | a bare `npm install` / `npm ci` — it rewrites `node_modules/.bin` under every other agent's in-flight test run, and two overlapping installs corrupt a package durably. ⚠ NOT claimed: an install naming a package operand (it may target a scratch tree `install:safe` cannot reach) or `--dry-run` |
| one relation's columns and their types | `dev:pg_query { describe: "schema.table" }` (same tool — also returns indexes, constraints and column comments) | a hand-written `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='…' AND table_name='…'`. ⚠ A column SEARCH across relations (`column_name ILIKE '%x%'`) has no describe form — keep querying the catalog for that |
| to FIND a relation whose name you half-remember | `dev:pg_query { describe: "*fragment*" }` — glob matched case-insensitively against `schema.name`; `{ describe: "schema.*" }` lists one schema | a hand-written `SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%fragment%'`. ⚠ Names only, one glob per call — an explicit `table_name IN (…)` list, a `table_type` filter, or anything else the catalog holds still wants information_schema |
| whether migration NNN applied, or the most recent migrations | `db:migrations { like: "795" }` — a bare number is a prefix match; an empty match returns a verdict (pending / draft-not-armed / no-such-migration) rather than an ambiguous zero rows | a hand-written `SELECT filename, applied_at FROM harness_shared.schema_migrations WHERE filename LIKE '795%'`. ⚠ One pattern per call — a `filename IN (…)` list, a POSIX-regex range (`~ '^(79[4-9])'`), `LIKE ANY (ARRAY[…])` or a `>= '750' AND < '760'` number range still wants SQL |
| a test file's run history, or which tests are failing | `testing:runs { filePath, status: ["fail","error"], sinceHours }` — typed status enum, and `outputTail` comes back on the red rows | `SELECT … FROM test_runs WHERE file_path LIKE '%x%' AND status='failed'` — ⚠ that literal can NEVER match (pass\|fail\|skip\|cancelled\|error\|running), so it reads as a clean "no failures". Aggregates, `DISTINCT ON`, an `output_tail` hunt, a `finished_at` window or `workspace_id IS NULL` still want SQL |
| to find filed issues by text, state, assignee or scope | `issues:list { q: "fragment", state, assignee, limit }` — `q` matches title + body, `rollup:"state"` gives counts over the whole filtered set | `SELECT … FROM engineer_issues WHERE title ILIKE '%x%'`. ⚠ NO id filter — a single-item read (`WHERE issue_id='WI-123'`) is `work_items:get { id }` — and no time-window arg, so a `created_at` slice, an OR of several fragments, a regex match, and `payload->`/terminal-column forensics stay SQL |

<!-- END GENERATED gen:tool-routing -->

The tool call is also cheaper than the shell round-trip it replaces: a structured
result, no subprocess, and no output to re-parse. When a row's caveat applies (a
`tail -f` follow, a non-operator database, a `\du`), the bash form is the right
answer — the gate will not fight you on those.

## `cd` outside the repo tree does NOT persist across Bash calls — a failed one silently falls back to the repo ROOT

**The Bash tool's own description says "the working directory persists between commands" — that is only true while you stay INSIDE this repo tree.** `cd /tmp/some-scratch-dir` succeeds and holds for the REST of that one call, but the *next* Bash call starts back at this repo's root, with a post-hoc `Shell cwd was reset to <repo root>` note on the PRIOR call's result — no warning before it runs, just after. `cd` to a path still *inside* the tree (e.g. a package subdir) genuinely persists across calls with no reset. So the boundary is exactly "inside vs. outside this tree", not "cd never persists".

**Why this is dangerous, not just surprising:** a multi-line script with no
`set -e` does NOT abort on a failed `cd` — it keeps executing every later line
in whatever directory it's actually sitting in. Combine the two: call 1's
`mkdir -p /tmp/x && cd /tmp/x` succeeds; call 2 opens with `cd /tmp/x` again
(cwd already reset to repo root) — if `/tmp/x` was never actually created (e.g.
call 1 was itself blocked by a `PreToolUse` gate before the `mkdir` ran), the
`cd` fails, prints "No such file or directory", and the REST of call 2's script
executes directly in **this shared monorepo root** instead of the intended
scratch dir. This is exactly how a `npm install <pkg>` meant for an isolated
scratch dir landed in the live tree and mutated shared `node_modules` while
other agents were working in it (repaired via `npm run install:safe`, no
lasting damage — but the near-miss is the point).

**The defensive pattern, every time a script leaves the repo tree:**
```bash
mkdir -p /tmp/my-scratch-dir && cd /tmp/my-scratch-dir || exit 1
# ...rest of the script — now guaranteed to abort instead of silently
# continuing in the wrong (repo-root) directory...
```
`cd ... || exit 1` (or `set -e` at the top of the script) is the whole fix — a
failed `cd` then kills the script instead of falling through. And when in
doubt whether a PRIOR call's `cd` actually landed you where you think, `pwd` as
the first line of the next call is free insurance — never assume.

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

⚠ **Never wait on a process-table pattern you typed yourself.** `until ! pgrep -f '<pat>'; do sleep 5; done` can NEVER exit from an agent shell: `pgrep -f` matches the FULL command line, and your own `bash -c` argv contains the literal pattern, so the poll matches ITSELF and the condition stays true forever — the same self-match class as the documented `pkill -f` trap. `ps … | grep <pat>` loop conditions share the defect, and `grep -v grep` does NOT save you (the `bash -c` wrapper still matches). The PreToolUse gate now denies the loop form. Wait on the PID instead (`tail --pid=<pid> -f /dev/null`, or `kill -0 <pid>` in the loop) — or, if you genuinely must pattern-poll, bracket the first character so the pattern cannot match its own argv: `pgrep -f '[l]int-tsc'`.

✅ **There is a purpose-built tool for this and you should reach for it FIRST —
`node scripts/proc-guard.mjs check <pattern>`.** It walks the CALLER's own
ancestor chain and excludes every pid in it before matching, so it cannot
self-match no matter where the pattern appears in your command (the pgrep
argument, an `echo` label, a comment, an `ls` path). 

⚠⚠ **`pgrep -q` DOES NOT EXIST on this box** (procps here has no `-q`), and this
one fails via the EXIT CODE rather than a spurious match, so bracketing does not
help. `pgrep -qf X && echo ALIVE || echo gone` prints **`gone`** on the usage
error — a well-formed answer to the question you asked, while the process is
very much alive (measured: it printed `gone` while `pgrep -cf` returned **13**).


> ⚠ `pgrep -x` matches `/proc/<pid>/comm`, which the kernel truncates to **15
> chars**, so a longer binary name never matches. 

✅ **"Is this process actually DOING WORK right now?" — a two-sample delta over the
process's CGROUP, never a single-shot reading and never a hand-walked tree.** Every
single-shot CPU probe answers a *different* question than the one you are asking, and each
fails toward a false "idle": `ps -o %cpu` is a **process-lifetime average** (measured: 208%
on a VM whose instantaneous load was 200% — right here only by coincidence, and badly wrong
for anything whose load has changed), and any first-iteration sampler has no prior sample to
difference against. CPU usage *is* a delta; ask for one:

```bash
# THE INSTRUMENT IS THE CGROUP, NOT A HAND-WALKED TREE. It accounts for EVERY descendant
# at ANY depth (nothing can hide below a walk bound), and usage_usec is a MONOTONIC
# counter -- so the delta is a true rate even as children spawn and exit between samples.
CG=$(sed 's|^0::||' /proc/<pid>/cgroup); F=/sys/fs/cgroup${CG}/cpu.stat
A=$(awk '/^usage_usec/{print $2}' $F); S=$(date +%s.%N); sleep 10
B=$(awk '/^usage_usec/{print $2}' $F); E=$(date +%s.%N)
echo "scale=2;($B-$A)/1000000/($E-$S)" | bc   # cores -- divide by MEASURED elapsed, never the sleep
wc -l < /sys/fs/cgroup${CG}/cgroup.procs      # how many processes that covers
# per-thread: two-sample fields 14-15 over /proc/<pid>/task/*/stat (tid == pid => MAIN thread)
```

Every `capability:bash` / `managedSpawn` job runs in its own systemd scope, so this is the
normal case here — and it is the same no-escape property the task manager relies on.

⚠ **A hand-rolled `/proc` walk reports a confident FALSE IDLE two independent ways, and
both were measured on runs burning a full core.** (1) A **depth-bounded** walk: this repo's
own test entrypoint is EIGHT levels deep (`bash → npm → sh -c → pc-heavy.sh →
affected-tests.mjs → npm → sh -c → node vitest → esbuild`), so a 6-generation walk stops at
a shell wrapper holding 0 ticks and the sum is dominated by processes that are legitimately
idle. (2) **One pid's** `utime+stime+cutime+cstime`: the `c*` pair is credited only when a
child is `wait()`ed on, and *vitest* reaps its own workers while the root reaps nothing
until the run ends — so a live worker contributes exactly zero. Reach for the `/proc` tree
sum ONLY for a process in no managed scope; if you must, print the members and confirm the
deepest one is the real worker rather than a `sh -c` wrapper.

⚠ **Measure the whole PROCESS TREE, not the pid you were handed** — a
service's `MainPID` is often a **wrapper** sitting at `utime=0` while the real
work runs in a child, so measuring it alone reports "idle" about a process
burning a full core. 

⚠ A corollary worth knowing before you design one: **a liveness/progress beat
emitted BY the process being judged cannot report on main-thread saturation** —
`await` yields to the microtask queue, not the event loop, so a saturated Node
main thread stops every `setInterval`/`setTimeout` while looking perfectly
asynchronous. The beat goes missing exactly when it is the thing you need.
Observe from OUTSIDE (`/proc`), where a saturated process cannot suppress its
own signal.

Treat `top -n1` as usable here; the two-sample `/proc` recipe is still the one to reach for, because it needs no column-index guess (`%CPU` is field **9** in `-H` output, not 8 — field 8 is the state column, and misreading it yields a whole column of `S` that looks like data).

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

⛔ **The dark allowlist is SHRINK-ONLY — never reconstruct or grow it, and never build a parallel one.** `KNOWN_DARK_FLAGS` exists ONLY to express the small set of genuinely-not-ready exceptions above (incomplete code / would-break-the-running-fleet / owner-authority / staged-cutover) — it is **NOT a parking lot for finished work**. `DarkCase` splits the set into two populations governed differently: the `DARK_FLAGS_HIGH_WATERMARK` size ceiling in `libs/flags/src/types.ts` (imported by `production-defaults.test.ts`) governs ONLY the **`parked`/`incomplete`** subset (`DARK_FLAGS_PARKING_COUNT`) — the actual parking-lot abuse; it **fails the build if THAT subset grows**, not the aggregate `DARK_FLAGS.size`. `owner-authority` / `cutover` entries (permanent or staged safety kill-switches) are **not rationed** by the watermark at all — they are governed only by the `DARK_FLAGS_REVIEW_BY` re-review date, so a legitimate new safety flag never has to fight a parking-lot budget. So: flipping a `parked`/`incomplete` flag ON *removes* its allowlist entry (the parking subset shrinks ✓); shipping a NEW genuinely-incomplete flag dark requires first **graduating an existing parked/incomplete dark flag** to make room (net-zero) or **explicit owner sign-off** to raise the watermark — never a quiet append. **Do NOT route around this guard** by re-introducing a second dark allowlist, a per-flag `process.env.PAPERCUSP_*` gate, a `darkReason` side-table, or any other parking-lot for finished-but-scary work: the temptation to park it dark "to verify later" is *exactly* the abuse this exists to stop — flipping it on and watching it work IS the task.

## Tests after editing

```bash
npm run test:affected                  # unit only — fast, default
npm run test:affected:integration      # also runs *.integration.test.ts
npm run lint:tsc -- --files=<the files you edited>   # TYPES — vitest does not typecheck
```

⚠ **`test:affected` runs the suites of the WORKSPACES your changed paths map into —
so "green" can mean "nothing ran". To see what your change actually selects, ask:**

```bash
node scripts/affected-tests.mjs --changed-paths scripts/lint-tsc.mjs,libs/flags/src/types.ts --print-affected
```

The print-only probe emits `AFFECTED_WS\t<workspace>` for selected workspaces and
`AFFECTED_GUARD\t<workspace>\t<script>` for repo-wide invariant guards attached by the
same run. Guard lines may appear even when there are zero `AFFECTED_WS` lines; that is
the intended fail-safe behavior for root-level changes.

⚠⚠ **`lint:tsc` typechecks `packages/operator-core` ONLY** — it is a single
`tsc -p packages/operator-core/tsconfig.json` (`scripts/lint-tsc.mjs`). 

**The trigger to watch: adding a REQUIRED field to a shared interface** (or renaming
/ re-typing one). 

**Don't do that by hand — `npm run lint:required-field-strands`** AST-diffs your change against `HEAD` and names every exported type that gained a required field, nested paths included. It also catches a field TIGHTENED from optional to required, which strands sites just as hard. It is ADVISORY by design — adding a required field is usually correct, so the mere addition is never a failure; `--typecheck` runs `lint:tsc` and exits non-zero only on real stranded sites. Finding the sites was never the hard part — `tsc` already does that perfectly; the gap this closes is *knowing to run it*. ⚠ Do NOT "fix" the errors by making the new field optional: that silently reintroduces whatever under-reporting the required field was added to prevent.

**A migration that ADDS a column to a `harness_shared` table can silently strand a
sibling `*.integration.test.ts` fixture** that hand-rolls that same table via an inline
`CREATE TABLE` instead of applying real migrations — the fixture used to be
schema-complete for every column it named and quietly falls one behind, and
`test:affected` won't select the stale file (your migration's diff never touches it).


Schema/migration edits (`libs/papercusp/libs/db/**`) → `npm run
test:all:integration` (the dependency graph won't catch them). Don't run
`npm run test:all` for routine edits. Each app/lib ships a `TESTING.md` — read it
before adding tests. Infra (Vitest 4, testcontainers PG, Docker required, CI,
property tests, knip, quarantine, secrets):
[repo-conventions § test infrastructure](/internal/docs/system/repo-conventions).

**npm only — never `pnpm`/`yarn` in this repo, even for a single-package test
run.** This is an **npm workspaces** monorepo (root `package.json`'s
`preinstall` runs `only-allow npm`); there is no `pnpm-workspace.yaml`. 

```bash
npm run test:file -- path/to/one.test.ts path/to/two.integration.test.ts
```

## Proving a guard is falsifiable — never mutate the shared tree to do it

A guard test that has never failed is a guard you have not tested. Proving it CAN
fail is correct discipline — but the obvious way to prove it is unsafe here, and has
already cost a committed mutant:

```bash
cp "$F" "$B"; <mutate>; <run the suite>; cp "$B" "$F"     # ⛔ never do this
```

It fails in **two independent ways**, and the second is not fixable by being careful:

1. **DEATH RACE** — the restore is the LAST statement, so anything that kills the
   command partway (the 2-min foreground Bash deadline, a SIGTERM, a compaction)
   skips it. A `trap` fixes this one.
2. **SWEEP RACE** — git-sync commits the WHOLE working tree every few minutes, and a
   probe legitimately holds the file mutated for as long as the suite runs. A sweep
   landing in that window commits the mutant *even though nothing went wrong and the
   trap never fired.* **A trap cannot fix this — it is a mitigation, not a fix.**

A mutation probe that mutates the shared tree can be committed by the sweep even when nothing goes wrong and no handler fails. `git status` cannot warn you either: on a swept tree a clean status means the sweep ran, not that the file is unmodified.

**Pick the lowest tier that fits — the top two never dirty the tree at all:**

| your subject | how to prove falsifiability |
|---|---|
| a MODULE / logic you `import` | Keep a deliberately-wrong implementation **permanently in the test file** as a control (plus a calibration case the REAL subject must pass, or the controls also pass when the property itself is broken). Never mutate production code. |
| a FILE artifact the test reads by path (shell scripts, config, generated output) | Mutate a **COPY** outside the tree and point the test at it — zero window, no lock, no trap. Make the test's subject path overridable (an env var defaulting to the real path); that one line is what makes tier 2 available at all. |
| genuinely unavoidable in-tree mutation | Last resort. Hold the sweep for the probe's duration AND restore from a trap (see below). |

**`scripts/mutation-probe.sh` implements tiers 2 and 3** so nobody hand-rolls the unsafe
shape again. Copy-out is the default; it proves the tracked file is byte-identical
before exiting, and it **refuses a mutation that changed nothing** — a no-op mutation
makes any guard look weak, which is a false verdict from a probe that never mutated
anything.

```bash
scripts/mutation-probe.sh --file scripts/verify-tauri-headless.sh \
  --mutate 's/^\s*port_lost_to_squatter .*$//' \
  --test 'PROBE_SCRIPT={} npm run test:file -- apps/operator/lib/verify-tauri-headless-bind-retry.test.ts'
```

Exit codes: `0` mutant CAUGHT (guard is falsifiable ✓) · `1` mutant SURVIVED (your guard
is weaker than you think) · `2` misuse / no-op mutation · `3` in-tree restore FAILED, act
now. Note `0` means *the guard failed on the mutant* — "the probe succeeded" and "the test
passed" mean OPPOSITE things here.

For tier 3, pause the sweep from your agent session — git-sync's own tick takes this
same lock and **skips when a peer holds it**:

```
locks:acquire_resource { resource: 'git-sync:papercusp', mode: 'exclusive',
                         ttl_sec: 600, reason: 'mutation probe' }
```

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
3. **Add `guidance: { when, notWhen?, chaining?, byRole? }`** 

   > It is a ROOT entrypoint that queues behind `scripts/pc-heavy.sh`, which is
   > what makes it runnable when you actually need it. 

> **Editing a live tool counts too.** In practice nearly every prompt-weight gate
> red has come from *growing* an existing tool's `description`/`guidance`, not from
> adding a new one — and an editor never reads an "Adding a tool" section, so the
> breach lands committed and freezes the fleet gate hours later. 

Per-tool when/not-when goes on the tool; cross-tool patterns in
`<role>.tools.md`; behavior rules in `<role>.persona.md`. The split is
intentional — see `packages/operator-core/lib/prompt-assembly.ts`.

⚠ **A caller's `limit` bounds ROW LISTS ONLY — never an aggregate. If a count is
computed over a capped fetch, the RESULT must say so ON THE AGGREGATE.** Marking
only the row list is not enough: the aggregate is what gets read as a verdict, and
a bounded measurement rendered as a confident number is indistinguishable from a
real zero. 

The fix pattern, both halves: pin the census fetch independently of the caller's
`limit` (`censusLimit`), and expose a boundedness marker beside the counts
(`truncatedByLimit`) so a floor is never read as a total. **Guard it behaviourally,
not by field name** 

## Prompts are auto-generated — edit the source, never the rendered output

Every agent-facing prompt is assembled at launch/spawn from sources: chat-surface
roles from `apps/operator/prompts/<role>.{persona,tools}.md` + the tool-guidance
catalog; psu playbooks from
`apps/operator/prompts/papercusp-su-{engineer,power}.tools.md` (which splice
THIS `CLAUDE.md` in as the Project guide — repo-convention changes belong here);
harness spawn prompts from `libs/papercusp/packages/harness/prompts/<role>.md`.
**Never edit rendered outputs** (`~/.papercusp/*-collaborator*.md`, anything
under `papercup-release`, captured prompts). Dev edits load immediately
(`PAPERCUSP_RELOAD_PROMPTS=1`). After a `<role>.tools.md` edit run
`npm run lint:tool-prompts`; after a substantial SU-playbook edit run
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
