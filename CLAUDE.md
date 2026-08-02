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
| is the gate judging MY code | `changeInCandidate.judgingContainsPath` — but ONLY trust a `true`, and read `missingReason` before believing a `false` (see below) | assuming a red is about your change — a run judging a candidate without it isn't |
| will the next tick commit my half-finished refactor | `sweepExposure` (blast radius + when) | nothing — git-sync sweeps the WHOLE tree, so `git-sync:run` mid-refactor commits the broken intermediate on purpose |

`nextAction: null` is a **positive** answer ("waiting is correct"), never a missing one —
do not invent a lever when the honest move is to wait. Full field-by-field guide:
[reading pipeline state](/internal/docs/agent-insights/reading-pipeline-state-position-health-nextaction).

⚠ **`judgingContainsPath: false` with `missingReason: 'newer-commit'` does NOT mean your
change missed the candidate — and on a shared file it usually means the opposite.** That
verdict compares the path's **current content**, so the moment ANY peer commits to the same
file after you, it flips false and stays false: the tip is always newer than the quiet-cut
candidate. Following the re-fire lever it used to emit can therefore never succeed — it just
restarts a ~55min suite clock. This cost ~2h of the 2026-07-27 fleet-wide `facts:assert`
outage (EI-18797292094433710): two wakes re-fired the gate while *every* candidate already
carried the fix.

⚠⚠ **STEP 0 FIRST — establish WHICH sha is actually being judged. Skipping this is the
expensive mistake, and no amount of care in the steps below can recover from it.** The
`candidate` field DRIFTS: a single continuous run reports different candidates over its
lifetime. Observed 2026-08-02: one run with an unchanged `started_at` of 07:15:17Z (elapsed
climbing 1138 → 2887s, so provably not a new run) reported `1ee32228` and later `4a9b218ba0`.

**That drift is a FEATURE, not corruption.** The gate AUTO-RE-FIRES onto tip *inside the same
process* — see "A RUN'S JUDGED CANDIDATE CHANGES MID-RUN" below for the mechanism and for the
`inFlightRetriage` marker, which is **the authoritative answer to "which sha is this run
judging"**. In the case above the run genuinely had re-candidated onto `4a9b218ba0`, and that
candidate genuinely did carry the fix.

🚫 **Do NOT settle this by comparing commit dates to the run's `started_at`.** This file used to
prescribe exactly that — `newer than started_at? -> the field is BOGUS`, justified by "a run
cannot judge a commit that did not exist when it started". **That is WRONG for this gate, and
the recipe has been removed.** `apps/operator/lib/release/green-checkpoint.ts` recurses into
`runGreenCheckpoint(..., { candidate: tip, refireAttempts: +1 })` in-process at two sites —
L2617-2621 (test-file rescue) and L2661-2665 (the lint/typecheck sibling, which is the path a
`lint:tsc` red takes) — so `pid` and `started_at` stay FIXED while the candidate legitimately
advances past them. **A candidate newer than `started_at` is the expected signature of a healthy
re-fire.**

That check was seductive precisely because it looked free ("no marker/blob/ancestry needed"),
and it fails in the most expensive direction: it fires a false `BOGUS` exactly during the
re-triage window — i.e. when the gate is rescuing itself — and the reflex that follows a `BOGUS`
verdict is to fire a manual `release:checkpoint-run`, which discards the rescue and costs a full
suite. If you carry the old rule in memory from an earlier session, drop it.

⚠ **Do not try to settle step 0 by reading a checkpoint worktree.** There are at least two and
their names differ by one letter — `papercup-checkpoint` (HEAD dated 2026-07-02, a month stale)
and `papercusp-checkpoint` — plus transient `papercusp-checkpoint-simtmp-*` dirs. On 2026-08-02
neither matched the candidate the tool was reporting, and reading the wrong one produced a
confident wrong answer that went out to 16 agents. A worktree HEAD is a *live* read of a tree
that may be between runs, mid-reset, or simply not the one the gate is using.

⚠ On that same `held_externally: true` (cron) reply the fields have **OPPOSITE** trustworthiness, so
do not tar them with one brush — this file used to, and discredited the only reliable one (WI-7041):

- **`started_at` / `elapsed_sec` — TRUST THEM.** They do NOT describe the idle manual unit. They come
  from `checkRunLockHeld`, which reads the RUN LOCK's owner record and returns nothing unless
  `pidAlive(owner.pid)` — so they describe the process actually holding the lock, i.e. the cron run.
  Measured 2026-08-02 11:48Z: `ps` put pid 514562 at 11:15:03Z, the tool reported 11:15:04.561Z and
  `elapsedSec 1980` (33m), matching wall-clock. Run age + a liveness-verified lock owner is exactly
  what separates "healthy long run, wait it out" from "wedged, intervene".
- **`candidate` — AN INFERENCE, not an observation.** This branch returns before the log parse and
  reports the checkpoint checkout's live HEAD, which silently changes between two reads and is right
  only while that checkout stays pinned. This is the field that deserves the caution — settle it
  from the `inFlightRetriage` marker instead.

**The only primary observation is the verdict itself, which names its own candidate.** When the
containment question cannot be settled from primary evidence, say so and wait — do not arbitrate
it from these fields. Four agents produced four contradictory conclusions here in ninety minutes,
each reasoning correctly from the same untrustworthy inputs.

✅ **THE PRIMARY SOURCE THAT WORKS FOR EVERY RUN — the routines marker in Postgres.** It is the
ONLY read that answers step 0 for a SCHEDULER-fired run, and it is the authority for a LIVE one:

```sql
SELECT metadata->'gate_health'->'inFlightRetriage'   AS live_refire,     -- the LIVE run's candidate
       metadata->'gate_health'->>'observedCandidate' AS last_completed,  -- the LAST COMPLETED pass
       metadata->'gate_health'->>'consecutiveReds'   AS reds
  FROM harness_shared.routines
 WHERE target_role = 'system:green-checkpoint'
   AND install_slug = '<harness>' AND workspace_id = '<workspace>';   -- multi-tenant: scope BOTH
```

The two keys answer DIFFERENT questions — conflating them is its own confident-wrong-answer path:

- **`inFlightRetriage` non-null ⇒ its `refiringCandidate` IS the sha being judged right now.** Null ⇒
  no refire in flight ⇒ the run is still on its first candidate. Treat a marker older than 3h as an
  abandoned run.
  ⚠ **`refireAttempt`/`maxRefires` are NOT "how much rescue budget is left"** — this file used to say
  they were, and that reading is wrong in the direction that costs you a suite. There are **two**
  bounds and they advance differently (EI-19343532231631821): `refireAttempt` counts only refires
  whose failures OVERLAP the set already being rescued — i.e. **FAILED** rescues — while
  `totalRefires` counts every refire and is bounded by `absoluteCeiling` (= `maxRefires` × 3). So a
  run five successful rescues deep reads `refireAttempt 0/2` — indistinguishable from "hasn't
  refired yet" — while sitting one red away from the ceiling, where the next red really does STICK.
  Read BOTH, and prefer the tools: `dev:pipeline_position`'s mid-rescue note and
  `release:checkpoint-run`'s `in_flight_retriage.budget`/`at_cap` both render them via one shared
  helper (`describeRefireBudget`, `packages/operator-core/lib/release/in-flight-retriage.ts`), so
  they cannot drift from each other or from this paragraph.
- **`observedCandidate` names the LAST COMPLETED pass**, never the live one — the same caveat this
  file already states for the persisted checkpoint-logs. Reading it as the in-flight candidate is a
  guaranteed one-pass-stale answer.

⚠ **Scope BOTH `install_slug` AND `workspace_id`.** That table is multi-tenant, one row per harness.
Measured 2026-08-02 11:44Z, ordering it `last_fired_at DESC LIMIT 5` returned oddsmith,
hello-world-hive, dummy-pot-0707, quartermaster and hello-world-3 — `papercusp` was not in the top
five. An unscoped query returns some other harness's gate: well-formed, confident, wrong.

🚫 **The `/tmp/papercup-green-checkpoint-manual-*` grep below covers MANUAL runs ONLY — a
scheduler-fired run writes no such log at all.** This file used to present that grep as *the* answer
to step 0. It is cron-blind, and it fails in the most expensive direction: `ls -t` cheerfully returns
the newest MANUAL log, which during a cron red is hours old, and its last `checkpointing candidate`
reads exactly like a fresh answer. Measured 2026-08-02 11:45Z against the live 11:15:03Z cron run —
the grep returned `4961cfb8` (discarded ~2h earlier) while the marker returned
`refiringCandidate: 16dbb52a7849`; the running process (pid 514562) held no `.log` fd at all. Two
agents hit this in one morning, one correctly filing "candidate undeterminable" while the answer sat
in Postgres (EI-19340690933031666).

**For a MANUAL run the run's own log is still a good second source.** It emits
`checkpointing candidate <sha>` (green-checkpoint.ts:2348) *once per candidate*, and the in-process
auto-refire RE-EMITS it — so the **LAST** match is the sha being judged, and the number of matches is
the number of candidates that run has had:

```bash
# MANUAL runs only. Pick the NEWEST log by mtime FIRST, then take that ONE file's last candidate.
# Check that mtime against the run you care about — a stale manual log looks identical to a fresh one.
f=$(ls -t /tmp/papercup-green-checkpoint-manual-*T*Z.log | head -1)
grep -o "checkpointing candidate [0-9a-f]*" "$f" | tail -1
```

⚠ **Do not collapse that to a single `grep … *T*Z.log | tail -1`.** The glob expands sorted by the
UNIT-NAME segment before the timestamp, so the alphabetically-last file is not the newest run —
measured 2026-08-02, the one-liner returned a candidate from a **2026-07-17** log belonging to a
different unit. Select the file by mtime, then grep it.

Measured 2026-08-02 on the live 08:37Z run: `14fb28da` at byte 177, `auto-refiring (attempt 1/2)`,
then `4961cfb8` at byte 2281 — two candidates, one run, and the second is the real one.
Cross-checked against the verdict's own persisted log, whose FILENAME independently names it:
`~/.papercusp/checkpoint-logs/<ts>-base-<sha>-cand-4961cfb8b3fc.log`. Those two sources are
independent, so when they agree the candidate is settled. Note the persisted log is written at each
pass's END, so during a live run it names the PREVIOUS pass — use the persisted filename to confirm a
COMPLETED verdict, and for a run still in flight prefer the `inFlightRetriage` marker above (the
`/tmp` unit log only exists if that run was fired MANUALLY).

⚠ **Do NOT take the FIRST match, and do not trust `release:checkpoint-run`'s `candidate` over this
grep.** Until EI-19327704778173646 that field came from a bare `.match()` on the log — the FIRST
occurrence — so after a refire it reported the sha the run had already DISCARDED, while the reply's
own prose said "verify your fix against THAT sha." Its `held_externally` sibling fails the opposite
way: it reads the checkout's live HEAD, so it is CORRECT but silently changes between two reads.
That opposite-direction pair is why two careful agents could observe contradictory things and both
be right. The fix reports the LAST candidate and adds `initial_candidate` / `refire_observed`, so a
candidate that legitimately MOVED now says so instead of looking like corruption.

⚠ Two traps specific to this grep: keep the `*T*Z.log` glob (bare `-manual-*.log` also matches the
synthetic test logs — EI-19326961954611487), and note these shas are **8-hex** on purpose
(`candidate.slice(0, 8)`), so the "ignore any sha that is not 40-hex" rule stated below applies to
the displacement lines, *not* to `checkpointing candidate`.

**Then — and only then — settle containment with ancestry + blob against THAT sha. Step 1
without step 0 proves the right thing about the wrong object:**

```bash
C=<the candidate you confirmed in step 0>; F=<your path>; S='<a string your change INTRODUCED>'
git log --oneline -S"$S" -- "$F" | tail -1     # OLDEST count-changing commit = the INTRODUCING one
git merge-base --is-ancestor <that commit> $C && echo IN || echo NOT-IN
[ "$(git rev-parse $C:"$F")" = "$(git rev-parse HEAD:"$F")" ] \
  && echo BLOB-IDENTICAL || echo INCONCLUSIVE   # blob-level confirmation
```

⚠ **The blob line compares IDENTITY, not a count — and this is a correction, not a
style preference.** It used to read `git show $C:"$F" | grep -c "$S"`, which is the
very check this file warns about forty lines below ("**A count DELTA is not
presence**"). A count is satisfied by any pre-existing occurrence of `$S`, so it
returns a confident nonzero for a candidate that does not contain your change; that
produced repeated retracted verdicts on 2026-08-02. Comparing blob SHAs cannot be
fooled that way, and needs no unique string at all.

**It is asymmetric — read it in one direction only:**

- **`BLOB-IDENTICAL` → definitive YES.** The candidate's version of that file *is*
  byte-for-byte yours. Nothing further to check; stop here.
- **`INCONCLUSIVE` → NOT "absent".** It means only that the file differs somehow —
  and on a file the fleet is editing, a peer's later commit makes it differ almost
  always. Fall back to the ancestry form above (`git log -S… | tail -1` +
  `--is-ancestor`), which isolates *your* introducing commit — but read BOTH caveats
  below first (`tail -1` not `-1`, and `-G` not `-S` when searching by a name), because
  that fallback is where both false-negative traps live.

Treating `INCONCLUSIVE` as "my change is missing" would re-create the `marker` bug
with the sign flipped, and send you to re-fire a gate that already carries your work.

⚠ **`tail -1`, not `-1`.** `-S` lists every commit where the occurrence count changed,
**newest first**, so `git log -1 -S…` returns the MOST RECENT such commit, not the introducing
one. They differ whenever you touch a symbol twice — the normal case for work in progress — and
testing ancestry with the newer commit against a candidate cut between the two reports `NOT-IN`
while your change is in fact present. That is the exact false negative this recipe exists to
eliminate, and it sends you off to re-fire a gate that already carries your change.

Verified in this repo 2026-08-02 — `backingTables` in `sync-resolver/index.ts` has **five**
count-changing commits, and against gate candidate `1ee32228` the two forms disagree:

```
git log --oneline -1 -S backingTables -- "$F"        -> bd5ba29a9b : NOT-IN  <- FALSE NEGATIVE
git log --oneline    -S backingTables -- "$F" | tail -1 -> 362398846f : IN   <- correct
blob truth: backingTables occurs 14x in that candidate                       <- plainly present
```

⚠⚠ **`-S` is blind to a change that REWRITES a line without changing occurrence counts — use
`-G` whenever you are searching by a NAME you did not introduce.** `-S` lists commits where the
COUNT of the string changed. A commit that swaps a keyword, retypes a declaration, flips an
operator, or edits a value leaves the count identical, so `-S` cannot see it at all — and
`--is-ancestor` then answers correctly about the WRONG commit, which is worse than answering
nothing. `-G` matches any diff line touching the pattern and does see it.

The recipe above is still right *on its own terms*: `S='<a string your change INTRODUCED>'` is
genuinely new, so its count genuinely changes. The trap is the entry path — you reach for this
recipe precisely when a peer hands you a root cause as an IDENTIFIER ("the bug is
`AdvRosterArgs`"), and an identifier is a pre-existing token, not an introduced string.

Verified in this repo 2026-08-02 on `apps/operator/lib/adv-roster-args.ts`. The gate-red fix
`66908db5bf` changed `-export interface AdvRosterArgs {` → `+export type AdvRosterArgs = {`,
leaving the count at 1:

```
git log --oneline -S'AdvRosterArgs' -- "$F"   -> afba95d487              <- MISSES the fix
git log --oneline -G'AdvRosterArgs' -- "$F"   -> 66908db5bf afba95d487   <- correct
```

Cost when it fired: an agent used `-S`, concluded a peer's correct root-cause attribution could
not be corroborated, and broadcast that doubt hive-wide before retracting it (WI-7030).
**Rule of thumb: searching by a name you did NOT introduce → `-G`; by a string you DID introduce
→ `-S`. When in doubt run both — they disagree only in the cases that matter.** Note that the
BLOB-IDENTITY check above is immune to both this and the `tail -1` trap, which is why it is the
primary and log archaeology is the fallback.

**No string unique to your change?** Use a *semantic discriminator* instead of a token: diff the
CHANGED ASSERTION TEXT between candidate and HEAD. The OLD text disappearing is as informative
as the NEW text arriving, and unlike a token count it cannot be satisfied by something that
pre-existed.

⚠ **This corrects two claims this section used to make.** Both were wrong, and together they
pushed the fleet onto the unreliable path — three agents independently hit the resulting
false verdict inside ten minutes on 2026-08-02 (EI-19325709344484737, EI-19325915429897280):

- ~~"`--is-ancestor` has nothing sound to test"~~ — **false.** It is true that git-sync commits
  the whole tree under one identity, so no commit is identifiably yours *by author*. But
  `git log -S'<a string your change introduced>'` finds the commit that INTRODUCED your change
  regardless of who authored it, and `--is-ancestor` on **that** commit is exact. Authorship
  being unusable does not make ancestry unusable.
- ~~"The marker verdict is definitive both ways"~~ — **false.** `marker` is a substring/count
  test with no notion of attribution, so a marker that is not unique to your edit returns
  `present: true` and, worse, flips the `onStaging`/`inMain`/`deployed` legs from a correct
  `false` to a wrong `true` with prose explaining the correct answer away as a newer-commit
  artifact. Measured: marker `operator_turns` (already present 1× in the unmodified file)
  reported a change as on staging, in main AND deployed when it was in none of the three.
  **ANY nonzero count is unsafe when the token pre-existed** — a high count is not "obviously
  wrong enough to catch". Corroborated independently the same morning: `knownQueryNamesV2`
  stood at 3 in a candidate that provably lacked the fix and 4 at HEAD, and that symbol *looks*
  specific to the change. **A count DELTA is not presence.** Count-1 is merely the most
  seductive case, because count-1 is exactly what a genuine one-line addition looks like, so
  nothing on the surface looks wrong at all.

`marker` is still useful as a *quick* check, but only if the string is one the change
**INTRODUCED** and that the file never contained before — never a bare identifier, table name,
or type name the file already used. Treat a marker result as a hint; treat ancestry+blob as
the verdict.

⚠ **`callerEditsInCandidate.missing` with `reason: 'uncommitted'` is NOT evidence about YOUR
committed change on this shared tree.** `release:checkpoint-run { paths }` compares the
**working tree**, and every agent's edits sit unstaged until the next git-sync tick — so any
peer's dirty edit in a file you name reports that file as `uncommitted`/missing even when your
own fix is committed and demonstrably inside the candidate. Observed 2026-08-02 07:47Z:
`sync-resolver/index.ts` came back `missing … reason: 'uncommitted'` while
`--is-ancestor` + a blob grep proved the fix was in the candidate — the dirty edit belonged to
a different agent working an unrelated resolver change in the same file. On a hot shared file
this reason is near-permanently true and says nothing about you. `absent` is the honest miss;
`uncommitted` is not.

⚠ **`reason: 'newer-commit'` is the SECOND face of that same bug — and unlike `uncommitted` it
fires on a fully-committed change.** Observed 2026-08-02 08:00Z (EI-19326775809436764): the check
appears to compare the path's *current* content (or its latest touching commit) rather than
asking whether the commit that INTRODUCED your edit is an ancestor of the candidate. So on any
file the fleet edits, a peer's commit landing after yours flips your file to `missing … reason:
'newer-commit'` and *stays* there — the tip is always newer than the quiet-cut candidate. Two
ways it actively misleads: `excludedCommitsTouchingYourFiles` names that **peer's** commit as
the one "carrying your file", and the warning prescribes *"wait out the quiet window (~4 min)
and re-fire"* — a fresh ~55min gate clock for a candidate that already contains your fix.
Measured: `sync-resolver/index.ts` came back `missing`/`newer-commit` citing a peer's unrelated
`readOutbox` change, while `git merge-base --is-ancestor 07d759d576 4a9b218b` said IN and a blob
grep counted the fix present. Three agents had built a re-fire plan on that verdict before it was
caught. **Neither reason code is evidence about your change — settle it with ancestry+blob above,
and treat every containment field (`marker`, `changeInCandidate`, `callerEditsInCandidate`) as a
hint that fails in the direction of arguing for a wasteful re-fire.**

⚠⚠ **A RUN'S JUDGED CANDIDATE CHANGES MID-RUN — "which sha is this run judging" has no single
stable answer, and every source below answers a slightly different question.** On a red that
re-tests clean at tip, `green-checkpoint.ts:2600-2621` calls `runGreenCheckpoint(..., { candidate:
tip, refireAttempts: +1 })` **recursively, inside the same process** (cap `autoRefireCapFromEnv()`,
currently 2). So the **pid and start time stay FIXED while the candidate ADVANCES** — and a run
that has been alive for an hour may be on its second candidate, having already discarded the red
you are still reasoning about.

This single unstated mechanism cost 5–6 agents ~2h and at least four public retractions on
2026-08-02, because it makes true observations look mutually contradictory:
`checkpointRunInFlight.candidate` advancing under an **identical `startedAtMs`** is not corruption —
it is the auto-refire's signature, and it was retracted as impossible. `ps` showing ONE process
since 07:15Z was simultaneously true and never contradicted it.

**The authoritative read of a LIVE run** is the marker the refire writes for exactly this purpose:

```sql
SELECT metadata->'gate_health'->'inFlightRetriage'   -- fromCandidate / refiringCandidate
  FROM harness_shared.routines                        -- refireAttempt / maxRefires / observedAtMs
 WHERE target_role = 'system:green-checkpoint'
   AND install_slug = '<harness>' AND workspace_id = '<workspace>';   -- multi-tenant, scope both
```

`null` means no refire is in flight (the run is still on its first candidate). Treat a marker older
than `IN_FLIGHT_RETRIAGE_MAX_AGE_MS` (3h) as an abandoned run, not a long one.

⚠ **The persisted log names a COMPLETED pass, never the live one.**
`~/.papercusp/checkpoint-logs/<ts>-base-<sha>-cand-<sha>.log` is `writeFileSync`'d **once, at each
pass's END** — its first line is literally `candidate=… base=… written=<ISO> green=<bool>`, and the
filename timestamp is the WRITE time, not the run's start. Observed 2026-08-02: a log named
`…-cand-1ee32228e0cf.log` carried `written=07:38:58Z green=false` and a terminal
`AFFECTED_TESTS_RESULT status=failed` tail while its process was still alive 25 min later, having
already re-fired onto a newer tip. Reading it as the in-flight candidate is a guaranteed
one-pass-stale answer.

⚠ **Do not glob `/tmp/papercup-green-checkpoint-manual-*.log` and take the newest.** Tests write
synthetic placeholder shas into that same namespace, and `ls -t` routinely returns the TEST file
first (EI-19326961954611487). Observed 2026-08-02: the newest match was `…-manual-ryte5.log`,
containing only `was judging 11111111 … superseded by 222222222222` — which reads as a real
replaceStale displacement and is not. Real run logs are `…-manual-<unit>-<ISO>.log`, so match
**`/tmp/papercup-green-checkpoint-manual-*T*Z.log`** and ignore any line whose sha is not 40-hex.

🚨 **Never fire a manual `release:checkpoint-run` while a run is in its re-triage window.** That
window is where a STALE red gets voided and the gate re-fires itself onto a newer tip;
`green-checkpoint.ts:2566` states plainly that killing it "discards the rescue and costs a full
suite". A gate that looks stuck on a doomed candidate is very often seconds from rescuing itself —
check `inFlightRetriage` **before** concluding a re-fire is needed. Two agents were minutes from
firing one on 2026-08-02 while the automatic refire was already green on the affected suite.

✅ **You no longer have to remember to check — the verb itself now refuses with the answer**
(EI-19343516395023183). ⚠ On staging; **NOT yet deployed** while the gate is red, so the live
operator can still answer an in-flight rescue with the plain `held_externally` refusal — until it
ships, keep checking the marker yourself. Flip this caveat only when `dev:pipeline_position { path:
'packages/operator-core/lib/agent-tools/release/checkpoint-run.ts', marker: 'AUTO-REFIRE IN FLIGHT'
}` reports `deployed: true`; a doc promising an absent safety net is worse than silence, because it
makes the reader stop checking. `release:checkpoint-run`'s `already_running` reply reads the marker and,
when a refire is in flight for THAT run, leads its `note` with `🚨 AUTO-REFIRE IN FLIGHT — STAND
DOWN`, names both candidates (the one being judged **and** the one already discarded), lists the
files the abandoned red named so you don't go fix them, and reports the budget via
`in_flight_retriage.budget`/`at_cap`. Its containment check switches to the marker's candidate too,
so `callerEditsInCandidate` answers about the sha actually being judged rather than the checkout
HEAD inference. A marker written BEFORE that run started is deliberately NOT attributed to it (the
run-lock is a singleton, so it belongs to an earlier run) and the pre-existing refusal is returned
unchanged — `in_flight_retriage: null` means "no refire in flight", never "unknown".

⚠ And when it does re-fire: **a passing affected-tests suite is NOT a green gate.** The lint/perf/
desktop/delta gates and the `main` fast-forward still have to clear; an agent asserted "gate green"
off the suite result that same morning and had to retract it.

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
  ⚠ A work-item's **severity** (issue-family only: bug/change/task) has **two
  access paths, one per relation** — and the wrong one for a relation returns
  NULL for every row *without erroring*, so the query yields a well-formed,
  plausible, WRONG answer. Bind the accessor to the relation; never carry one
  across to the other (WI-6674):
  - **`harness_shared.work_items` (the TABLE)** has **no `severity` column** — it
    lives at **`payload->'_ei'->>'severity'`** (migration 374's fold). A raw
    top-level `payload ? 'severity'` audit always returns **zero rows**, which
    reads exactly like "no criticals" even when there are plenty.
  - **`harness_shared.engineer_issues` (the VIEW)** exposes **`severity` as a real
    column** — and deliberately drops the blob (`payload - '_ei'`) after exploding
    every `_ei` field into its own column, so on the VIEW
    `payload->'_ei'->>'severity'` is NULL for **every** row. Measured 2026-08-01:
    0 of 13,711 open rows via that path, 13,711 via the column, and **30 genuine
    criticals reported as none**. ⚠ An always-NULL-accessor advisory for
    `dev:pg_query` is WRITTEN BUT NOT YET LIVE (WI-6674) — verified 2026-08-01
    19:35Z: absent from origin/staging, `main` and the deployed release, and the
    live operator still answers this mistake with a silent `0`. **Do not rely on
    a warning; bind the accessor to the relation yourself.** Flip this sentence to
    present tense only when `dev:pipeline_position { path:
    'packages/operator-core/lib/pg-read-query.ts', marker: 'always-NULL accessor' }`
    reports `deployed: true` — a doc that promises an absent safety net is worse
    than silence, because it makes the reader *stop checking*.

  Prefer `work_items:list{severity}` / `work_items:claimable` over either raw path;
  the view scopes on `scope = 'harness:<slug>'`, not `harness_slug`:
  [work-item severity lives under payload._ei, not top-level](/internal/docs/agent-insights/work-item-severity-lives-under-payload-ei-not-top-level).
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
| to find where a symbol is DEFINED (and who calls it) | `gitnexus.context { name: "managedSetInterval", kind: "Function" }` | `grep -rn "export function managedSetInterval" --include=*.ts libs packages` (grep gives one matching line; the graph gives the definition plus callers/callees). ⚠ the index is refreshed by hand (`npx gitnexus analyze`) so it can lag new code; exhaustive exact-text search is still grep's job |
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

⚠ **A background job still has a wall-clock deadline, and reaching it TERMINATES the
job** — 4h by default, 12h max, `timeout` to raise it. The launch result now names the
deadline; a job that hits it says so in its own output (`[capability:bash] deadline
reached: exceeded Nms`) and the log keeps that line, so a deadline death is never
mistaken for an OOM or a peer's `pkill`. Read the deadline off the launch result rather
than assuming; for a job that legitimately runs longer than 12h, don't use this tool.

⚠⚠ That deadline **used to be 2 minutes** — the background mode inherited the FOREGROUND
default, so the remedy this very section prescribes SIGKILLed precisely the jobs it
recommends it for, unless you happened to also pass `timeout` (WI-6677). Fixed
2026-08-02: background now has its own default/ceiling, and the deadline sends SIGTERM
before SIGKILL so the job's `trap`/`finally` cleanup actually runs (the old SIGKILL
skipped it, stranding a 489MB checkout and a 4.9GB deb extract in two separate
incidents). **If you are reading a pre-2026-08-02 note that says a backgrounded job
"died at exactly 120s" or "vanished with no cause", that was this bug — not your
command.**

**Why the tool and not native `run_in_background`:** not because the tool is
crash-proof — it is not. Its in-memory job registry is wiped whenever *any* agent
restarts the operator on this shared box (EI-8855). The difference is
**recoverability**. `capability:bash` writes the job log to a deterministic
`stateDir + bash_id` path, so a poll after that still returns the log tail plus a
cause. There are **three** reason codes and they are not interchangeable
(EI-18666279107998059): `tracking_lost_process_alive` = CONFIRMED running via a
task-ledger pid re-probe — keep polling, do NOT re-run; `job_process_gone` = CONFIRMED
ended, the ledger observed a terminal state — safe to re-run; `job_liveness_unknown` =
only a whole-operator restart was ruled out (the uptime heuristic), liveness genuinely
UNKNOWN and the job is most often alive but QUEUED behind pc-heavy's slot clamp — check
`ps` before re-running, or you add load to the queue that is delaying you. ⚠ That
three-way split is **on staging but not yet deployed** while the gate is red, so the
live operator can still answer this case with a flat `job_process_gone` for a job `ps`
shows alive; until it ships, verify with `ps` rather than trusting the code. A
native background id is bookkeeping inside the CLI child's own memory: after a
compaction, carry-respawn, or cold-loop wake it is simply a dead reference with
nothing to recover (EI-16611).

So: **checkpoint the `bash_id`, never a native task id**, and never write "await
background task `<id>`" as a successor's next action.

⚠ **Never wait on a process-table pattern you typed yourself.** `until ! pgrep
-f '<pat>'; do sleep 5; done` can NEVER exit from an agent shell: `pgrep -f`
matches the FULL command line, and your own `bash -c` argv contains the literal
pattern, so the poll matches ITSELF and the condition stays true forever — a
peer burned 27 silent minutes exactly here (EI-19312699396945642; same
self-match class as the documented `pkill -f` trap). `ps … | grep <pat>` loop
conditions share the defect, and `grep -v grep` does NOT save you (the `bash
-c` wrapper still matches). The PreToolUse gate now denies the loop form. Wait
on the PID instead (`tail --pid=<pid> -f /dev/null`, or `kill -0 <pid>` in the
loop) — or, if you genuinely must pattern-poll, bracket the first character so
the pattern cannot match its own argv: `pgrep -f '[l]int-tsc'`.

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
>
> Since EI-19305736771912430 that trust extends to the **exit code**, not just the report:
> under `--files` a NEW file (one the baseline has never seen) that is outside the set you
> named no longer reds your run — so **a red under `--files` always means a file YOU named**.
> The unscoped findings are still printed, split into "uncommitted, a peer is likely mid-edit"
> and "COMMITTED: a standing red that WILL red the fleet" — the second kind needs an owner even
> though it is not your gate failure. `--mine` deliberately still fails on them: it *infers* the
> changed set from `git status`, and git-sync commits the tree every few minutes, so absence
> from that set is not evidence (EI-18766822535373909). `--files` *declares* it, which is the
> evidence `git status` cannot supply.

⚠⚠ **`lint:tsc` typechecks `packages/operator-core` ONLY** — it is a single
`tsc -p packages/operator-core/tsconfig.json` (`scripts/lint-tsc.mjs`). A change confined
to another workspace — **`libs/generic/*`, `libs/papercusp/*`, `apps/*`, other
`packages/*`** — is typechecked by NEITHER `lint:tsc` NOR vitest, so a type-only
regression there is invisible to *both* routine checks and first reds the
**green-checkpoint**. Editing outside operator-core? Also typecheck that workspace —
**`build:typecheck { project: "<workspace>" }`** (EI-18719561823587590).

> ✅ **`--files=` no longer lies about this** (EI-19341572300046923). Naming a path outside
> the project a gate compiles used to scope the VERDICT to files that compile never saw, so
> the run printed a clean result having typechecked **none of them** — a green indistinguishable
> from a real pass, and how two operator-vite reds reached the fleet gate on 2026-08-02. Now the
> gate checks coverage BEFORE the ~150s compile: if *every* named file is outside, it exits **1
> in ~0.15s** and names the command that does cover them (`npm run --workspace <dir> typecheck`);
> if only some are, it warns loudly and still reports the covered verdict. Coverage is derived
> from each CLI's own `-p` operand, so all four per-project gates (`lint:tsc`,
> `lint:tsc:operator-vite`, `lint:tsc:orchestrator`, `lint:tsc:papercusp-libs`) inherit it. It
> fails OPEN on an unparseable command — never a red it cannot substantiate.

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
`OwnerSteering.createWakeSuppressPlans`, `PipelinePosition.submodulePin`), and
`IssueClaimExclusionBreakdown.excluded.remoteOrigin` on 2026-08-02 (27 errors across 2
committed files, caught ~10 min before the gate run that would have red-pinned on them).

**Don't do that by hand — `npm run lint:required-field-strands`** (WI-6814) AST-diffs your
change against `HEAD` and names every exported type that gained a required field, nested
paths included (the 2026-08-02 case lived one level down, inside `excluded: {}`, where a
top-level scan reports nothing and reads exactly like "no trap here"). It also catches a
field TIGHTENED from optional to required, which strands sites just as hard. It is
ADVISORY by design — adding a required field is usually correct, so the mere addition is
never a failure; `--typecheck` runs `lint:tsc` and exits non-zero only on real stranded
sites. Finding the sites was never the hard part — `tsc` already does that perfectly; the
gap this closes is *knowing to run it*. ⚠ Do NOT "fix" the errors by making the new field
optional: that silently reintroduces whatever under-reporting the required field was added
to prevent (exactly the WI-6409 claim-floor bug).

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
