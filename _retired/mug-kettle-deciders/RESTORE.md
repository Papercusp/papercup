# Restore — Mug/Kettle/Cup tier deciders

Retired **2026-08-11** by plan `retire-mug-kettle-su-only-2026-08-09` (P-059), under
decisions **D-059** (the deciders are the real retirement unit), **D-060** (which
consumers are tier vs. genuinely live) and **D-075** (this destination, and why).

The Mug/Kettle/Cup tier is retired: **su + GOAL mode are the only way to drive the
app**. These modules are the tier's *deciders* — the pure functions and sweeps that
computed Mug placement, Cup wake efficiency, transcript caps and survey/ranking.

## Layout

Files mirror their original repo paths, so a restore is a mechanical copy back:

```
_retired/mug-kettle-deciders/<original path from repo root>
```

e.g. `_retired/mug-kettle-deciders/packages/operator-core/lib/pot/cup-fresh-context-delta.ts`
was `packages/operator-core/lib/pot/cup-fresh-context-delta.ts`.

## To restore a module

1. Copy it back to the path mirrored under this directory.
2. Re-add its importers. **Check `git log` for the P-059 slice that removed them** —
   most call sites were *deleted*, not merely re-pointed, because the feature they
   powered was the retirement's subject.
3. `npm run lint:no-retired` must stay green: nothing under `_retired/` may be
   imported by active code, so a partial restore that leaves one live import behind
   fails CI.

## Contents

| module | original path | why it retired |
|---|---|---|
| `cup-fresh-context-delta.ts` (+ test) | `packages/operator-core/lib/pot/` | The P-006 three-regime cost comparison for cup fresh-context vs. warm regimes. Exported `freshContextRegimeDelta` / `FreshContextRegimeDelta`. **Zero non-test importers at retirement** — its only consumer was its own test. |
| `mug-brief.ts` (+ test) | `packages/operator-core/lib/pot/` | The Mug's brief RENDERER — `renderMugBrief` / `floorFromSurvey` plus the floor/caps types. **One non-test importer at retirement, `mug-brief-launch.ts`**, which retired in the same slice; nothing outside the pair referenced it (`renderMugBrief` survived only in a stale comment in `pot/wake.ts`). |
| `cup-transcript-cap.ts` (+ test) | `packages/operator-core/lib/pot/` | The transcript-cap BACKSTOP decision + sweep (`shouldRecycleCupTranscript` / `runCupTranscriptCapSweep`). **One non-test importer at retirement, `bee-transcript-cap-action.ts`**, which retired in the same slice. Its routine row was never seeded, so the sweep had never fired. |
| `bee-transcript-cap-action.ts` | `packages/operator-core/lib/harness/routines/` | The `system:bee-transcript-cap` routine handler — the decider's sole consumer. Gathered live-cup metrics and nudged over-cap idle cups to checkpoint + recycle. |
| `seed-bee-transcript-cap-routine.ts` | `packages/operator-core/lib/harness/routines/` | The bring-up script for that routine's row (seeded INACTIVE). **Never run against this workspace** — no `bee-transcript-cap` row existed at retirement. |
| `mug-brief-launch.ts` (+ test) | `packages/operator-core/lib/pot/` | The Mug brief's ASSEMBLY + launch-time seams: `computeMugWakeBrief` (route-side wake brief, WI-682), `computePotPlacementSplit` (started/stopped hive partition), `computeMugBriefFloorView` (the `mugBrief.floorView` sync projection), `carryNoteHead`. **Three live importers at retirement, all deleted with it** — see below. |

### What the `mug-brief` pair's three live importers became (P-059 slice 2)

Recorded because restoring these files is NOT enough — the call sites were *removed*,
and each removal changed behaviour in a way a restorer must re-create deliberately:

| importer | symbol | what happened |
|---|---|---|
| `endpoint-route/routes/harness/spawn.ts` | `computeMugWakeBrief` | The `canonicalRole === 'mug'` auto-compute branch was deleted. The CHANNEL survives: a caller-supplied `body.queenBrief` still rides through to `env.MUG_WAKE_BRIEF`, which the orchestrator reads in `invoke.ts`. Only the compute is gone. |
| `pot/watchdog.ts` | `computePotPlacementSplit` | `potDemandCheck` no longer subtracts STOPPED hives' backlog — there is no started/stopped partition after retirement. Counts are now workspace-wide, which is the branch this function already took whenever the split read failed (its own comment: "fail-open ⇒ workspace-wide counts"). |
| `sync-resolver/index.ts` | `computeMugBriefFloorView` | The `mugBrief.floorView` sync query was removed outright, along with its `notifySyncInvalidate` in `system-health/compute.ts`. Its CLIENT was already gone (WI-37654 stripped the pane), and `PotHealthPane.test.tsx` guards against the key returning. |

⚠ Two `vi.mock('…/pot/mug-brief-launch')` stubs (in `blueprint/launch-blueprint.test.ts`
and `endpoint-route/__tests__/bootstrap-su.test.ts`) were removed as part of this slice.
Both had already decayed to no-ops before deletion: they mocked `computeQueenWakeBrief`,
a name the module stopped exporting at the queen→mug rename, so their paired
`not.toHaveBeenCalled()` assertions were **vacuously true** and would have passed however
the routes behaved. Do not restore them as evidence of anything.

### `mug-warm-session` (P-059 slice 3)

Retired: `mug-warm-session.ts` + `mug-warm-session.test.ts`. **1 live importer at retirement.**

| importer | symbol | what happened |
|---|---|---|
| `blueprint/blueprint-run-action.ts` | `mugWarmWakeAttempt` | The warm-wake wrapper around `defaultFire`'s cold `/invoke` spawn was deleted; the body now calls `coldFire()` directly. The wrapper's own documented fall-through WAS this cold spawn ("not ⇒ today's path, byte-identical"), and the attempt only ever acted for `role === 'mug' \|\| 'brain'` — roles the retired tier no longer spawns. |

Also removed with it:

- **`FLAGS.MUG_WARM_SESSION`** (`papercusp-queen-warm-session`) — deleted from
  `libs/flags/src/types.ts`. `mug-warm-session.ts` was its ONLY reader, so after the move it
  gated nothing. Restoring the module therefore requires re-adding the flag key.
- Its **ALLOWLIST entry** in `scripts/check-no-raw-install-slug-filter.mjs` (the
  `autoloop_state` relation verdict). That guard skips `_retired/`, so the entry was dead.

⚠ **The flag was DEFAULT ON, not dark** — graduated 2026-07-02 by owner flip directive. Do
not restore this module believing the path was dormant: `blueprint-run-action.ts`'s own
call-site comment claimed "MUG_WARM_SESSION, default OFF" and was **stale by five weeks**
(recorded as D-077). What made the deletion safe was the retired *tier* (no `mug`/`brain`
role is spawned), NOT the flag being off. If the Mug tier is ever restored, this module's
warm path becomes live again the moment the flag key exists.

### `cup-spawn-health-watchdog` (P-059 slice 4)

Retired: `cup-spawn-health-watchdog.ts` + `cup-spawn-health-watchdog.test.ts`. **1 live
importer at retirement.** It alarmed (WI-36299) when `cup:spawn` began failing — a monitor
whose entire subject is the retired tier: with `MUG_KETTLE_SYSTEM` off, `cup:spawn` refuses
by design, so the streak it watched for can no longer occur.

| importer | symbol | what happened |
|---|---|---|
| `dbos/bootstrap.ts` | `startCupSpawnHealthWatchdog` | The best-effort start block (its own `try`/`catch`, plus the WI-36299 rationale paragraph above it) was deleted from `startDbosBackgroundWork`. Its three sibling watchdogs in that block — green-stall, git-sync-stall, origin-freshness — are untouched and live. |

Also dead with it:

- The env kill-switch **`PAPERCUSP_CUP_SPAWN_HEALTH_WATCHDOG`** — read only by this module,
  so nothing consults it after the move. Restoring the module restores the switch.
- Its **`spawn-role|cup|…` entry** in `scripts/ungated-mug-kettle-baseline.json`, pruned
  because the baseline is shrink-only and the file is no longer an active-tree entry point.

⚠ Two surviving mentions are deliberate and must NOT be read as importers:
`harness/git-sync/quarantine-import-guard.ts` names this file in a **doc comment recording a
real past incident** (EI-19932544083689229 — a NUL-byte quarantine of the source whose clean
test sibling committed anyway, red-pinning the gate ~6h), and its test's fixtures use
**fictional `lib/…` paths**, not the real `lib/pot/…` one. Both are prose/synthetic strings
with no resolvable import, so neither breaks and neither needs restoring.

### `MugWakeEfficiencyPanel` — the UI leg (P-059, 2026-08-11)

Retired: `MugWakeEfficiencyPanel.tsx` + `MugWakeEfficiencyPanel.test.tsx`, from
`apps/operator-vite/src/components/adv/`. **First non-`operator-core` module in this
directory** — the layout rule is unchanged (mirror the original repo path), it simply now
has an `apps/` branch as well as `packages/`.

⚠ **This was a FEATURE DELETION, not a file move**, and that is the thing a restorer must
understand: the `wake-efficiency` Learning view is GONE, not flag-hidden. Restoring the panel
file alone gives you a component nothing routes to. Governing decision: **D-076**.

| importer | symbol | what happened |
|---|---|---|
| `adv/LearningTab.tsx` | `MugWakeEfficiencyPanel` | The import AND the whole `wake-efficiency` view were deleted: its `LVIEWS` member, its description-map entry, its `STAGES` nav entry (`Hourglass` icon — the import STAYS, still used at another site), and the render branch. |

Also removed with it, and each needs deliberate re-creation on a restore:

- **`MUG_KETTLE_VIEWS`** and the whole `mugKettleOn` leg of `LearningTab`. The set held that
  ONE view, so deleting it emptied the set, which made `hiddenViews`'s
  `if (!mugKettleOn) for (const v of MUG_KETTLE_VIEWS)` provably inert for every value of the
  flag. `hiddenViews(testingOn, mugKettleOn)` → `hiddenViews(testingOn)` and
  `visibleStages` likewise, with the `useFlag(FLAGS.MUG_KETTLE_SYSTEM)` read dropped from the
  component. **`FLAGS.MUG_KETTLE_SYSTEM` itself is untouched** — `adv/AdvNowRunning.tsx` still
  reads it; only LearningTab's use of it is gone.
- The **`MUG_KETTLE_SYSTEM: true` pin** in the `setTestingFlag` helpers of
  `LearningTab.test.tsx` and `LearningTab.lens-guard.test.tsx`. Those pins existed solely so
  that seeding from `FLAG_DEFAULTS` would not silently hide this view under every test in the
  file; with the view deleted they gated nothing.
- The **`"wake-efficiency"` member of `WORKSPACE_VIEWS`** in `LearningTab.lens-guard.test.tsx`.
- The gate suite `describe("Mug/Kettle tier gating (FLAGS.MUG_KETTLE_SYSTEM)")` was rewritten
  as `describe("Mug/Kettle tier retirement (wake-efficiency deleted)")`. Its flag-toggle cases
  died with the flag leg; its D-020 case (Red Queen / Frontier are NOT the Mug) and its
  stale-deep-link case both SURVIVE — see the warning below.

⚠ **`packages/operator-core/lib/pot/mug-wake-efficiency.ts` STAYS LIVE — do not retire it
with the panel.** The panel imported only its TYPE. The lib has three live non-tier consumers:
`system-health/compute.ts:412`, `sync-resolver/index.ts:4798`, and
`agent-tools/pot/mug_efficiency.ts`. This is the third live/tier split on this plan where a
shared name implied a shared verdict; assume nothing from the filename.

⚠ **The stale-deep-link behaviour survives by a DIFFERENT mechanism.** While the view existed,
`?lview=wake-efficiency` was a *known* id that `hiddenViews` hid, so the redirect came from the
flag gate. It is now simply absent from `LVIEWS`, so LearningTab's membership test rejects it
into the default view. Same observable, different path — the test was re-pointed, deliberately
NOT deleted, because real bookmarks and old links exist.

📉 **`learning-view-settle-coverage.guard.test.ts` baseline: 16 → 15.** BOTH sides of that
ratchet moved by one — `LEARNING_VIEWS` lost a member and the source scan lost a call site
(the panel had a `useInteractionSettle` point and `_retired/` is outside `SCAN_ROOTS`) — so
`unmeasured` stayed 0. Restoring the panel must move it back to 16, or the guard reds.

### `pot:survey` — the tool, its shaper, its own tests (P-059 slice 6, 2026-08-11)

**FIRST retirement of a GATED tool, so it is the precedent D-080 sets.** Four files moved to
`packages/operator-core/lib/agent-tools/pot/` under this dir:

| file | why it retired (measured at retirement) |
|---|---|
| `survey.ts` | the `pot:survey` TOOL. Gated at `:39` (`refuseIfMugKettleRetired`) ⇒ genuinely dead. Live importers: **none** — only its own two tests below. |
| `survey-shape.ts` | its payload-tier shaper. Importers at retirement: `survey.ts` + one test. Its ONLY production consumer was the retiring tool, so D-080 retires it too rather than leave dead code with a green test proving the dead code works. |
| `survey-claim-order-check.test.ts` | tests the tool. |
| `survey-workspace-scope.test.ts` | tests the tool. |

⚠ **`packages/operator-core/lib/pot/survey.ts` is a DIFFERENT FILE and is LIVE — do not
confuse them.** That one is the placement LIBRARY (`surveyPot`, `filterReadyFrontier`,
`resolvePotMembership`, …) with ~10 live importers, kept by **D-078**. The retired file is
the `agent-tools/` TOOL that imported *from* it. Both are named `survey.ts`; the tests are
even named alike (`survey-workspace-scope.test.ts` exists in BOTH trees — only the
`agent-tools/pot/` one retired).

**Three live-tree edits go with it — a restore must undo ALL of them:**

1. `agent-tools/index.ts` — the registration site. `import './pot/survey';` (was `:169`)
   replaced by a comment. **A restore that returns the file but not this line silently
   restores nothing**: the barrel is how the tool registers, and a bare side-effecting
   import leaves no other trace.
2. `agent-tools/mug-kettle-tool-gate.test.ts` — the `{ name: 'pot:survey', … }` row removed
   from `GATED`. **This is the D-080 contract in action.** The row asserted two things: the
   gate refuses the tool, AND (the calibration case) flag-ON restores it. Deletion removes
   the second property deliberately — flipping `papercusp-mug-kettle-system` back ON does
   NOT bring a retired, unregistered module back — so the row would assert a reversibility
   the system no longer honours. **The restore contract for that reversibility is now THIS
   FILE.** Restoring the tool must re-add its GATED row, or the gate coverage is silently
   lost. Same file: a `GATED.length > 0` anti-vacuity test was added (`describe.each([])`
   passes silently, and the EXCLUDED suites keep the file non-empty so `passWithNoTests`
   never fires either), and the header's hardcoded "nine tools" count was removed because it
   drifts on every slice.
3. `agent-tools/recall-reads-shape.test.ts` — narrowed, **not deleted** (D-080: a shared test
   keeps its surviving subjects). Its `describe("shapePotSurvey (P-024)")` block and the
   `ranked()` helper feeding it were removed along with the `./pot/survey-shape` import; the
   `shapeMemoryHit` half is untouched. Restoring `survey-shape.ts` must restore that block —
   `git log -- <this file>` recovers it verbatim.

## `kettle:declare-wake` — the Kettle's own wake verb (P-059 slice 7, 2026-08-11)

`packages/operator-core/lib/agent-tools/overwatch/declare_wake.ts` + `declare_wake.test.ts`.

**Why it retired:** gated at `:29` (`refuseIfMugKettleRetired`), and grep-verified at HEAD to
have **zero live importers** — only `agent-tools/index.ts` (registration), the GATED row in
`mug-kettle-tool-gate.test.ts`, and its own test.

⛔ **Do not confuse the TOOL with the PRIMITIVE.** `declareOverwatchTimeWake` in
`packages/operator-core/lib/overwatch/` is STILL LIVE — `lib/overwatch/loop.ts` calls it, and
`lib/overwatch/autonomy.ts` still keys its `LIFECYCLE_VERBS` policy on the *string*
`'kettle:declare-wake'`. Only the agent-facing tool retired. (`lib/overwatch/` is a LATER
P-059 slice; leaving that string is correct until then.)

**Five live-tree edits go with it — a restore must undo ALL of them:**

1. `agent-tools/index.ts` — the registration site (`import './overwatch/declare_wake';`, was
   `:182`) replaced by a comment. A restore that returns the file but not this line silently
   restores nothing. ⚠ The sibling `import '../overwatch/loop';` two lines below is a
   DIFFERENT module (`lib/overwatch/`, still live) — do not touch it.
2. `agent-tools/mug-kettle-tool-gate.test.ts` — the `{ name: 'kettle:declare-wake', … }`
   GATED row removed per D-080 (the restore contract for its reversibility is THIS file).
   ~~`kettle:start` stays in `GATED` and `kettle:pause` stays in `EXCLUDED` — both tools are
   still live as of this slice.~~ **No longer true as of the NEXT slice (below), which
   retired both.** Struck rather than deleted because it dates a claim: a reader restoring
   `declare_wake` needs to know those two rows were live *at that moment* and are not now.
3. `agent-tools/loop/arm.ts` — TWO pointers swept: the header comment and the `notWhen`
   guidance string both named `pot:declare-wake / kettle:declare-wake` as the autonomous
   counterpart loop; the Kettle half was dropped so live guidance cannot instruct a verb
   that no longer resolves.
4. `lib/scorecard-freshness.ts` — the `loop-dead` verdict's **actionable** note said
   "Revive it (kettle:start / kettle:declare-wake)"; narrowed to `kettle:start`. This one is
   emitted at RUNTIME to an agent, so a stale pointer here is a live wrong instruction, not
   a comment.
5. `libs/papercusp/…/blueprints/coding/prompts/kettle.md` — "Step 3: Declare your next wake"
   replaced by a retirement note. ⚠ This is the edit that keeps the tree GREEN:
   `prompt-blueprint-verb-catalog.test.ts` scans the prompt/blueprint corpus for the shape
   "call \`group:verb\`" and asserts the verb resolves against the live catalog, so leaving
   the original **ALWAYS call `kettle:declare-wake`** line would have redded the shared gate
   from a file two directories outside the one being retired. Note this file lives in the
   `libs/papercusp` SUBMODULE, so its restore is a submodule commit, not a superproject one.

## `kettle:start` / `kettle:pause` + the OverwatchTab UI (P-059, D-083)

Retired together, as ONE unit, because they are one feature: `OverwatchTab.tsx` was the
only non-test caller of either tool (`runOverwatchControl`, `:95`/`:201`), and the tools
were the only thing the tab could DO. Splitting them would have left either a panel whose
two buttons throw, or two tools no surface can reach.

| module | original path | why it retired |
|---|---|---|
| `start.ts` / `pause.ts` (+ `start-pause.test.ts`) | `packages/operator-core/lib/agent-tools/overwatch/` | The Kettle's loop control (`overwatch_started` bit + cadence + wake). **Two non-test importers at retirement**: `agent-tools/index.ts` (registration) and the UI below. This emptied `agent-tools/overwatch/` entirely — the directory is gone, so there is no overwatch tool group left. |
| `OverwatchTab.tsx` (+ test) | `apps/operator-vite/src/components/left-sidebar/` | The Kettle's sidebar panel. **Already-dead UI at retirement**: double-gated `OVERWATCH && MUG_KETTLE_SYSTEM`, both default OFF — the same feature-deletion shape as D-076's wake-efficiency panel. |

**Live-tree edits a restore must undo — SEVEN, and #6 is the one that is easy to miss:**

1. `agent-tools/index.ts` — both `import './overwatch/start';` / `'./overwatch/pause';`
   replaced by one comment. ⚠ `import '../overwatch/loop';` below is a DIFFERENT module
   (`lib/overwatch/`, still live, its own later slice) — do not touch it.
2. `agent-tools/mug-kettle-tool-gate.test.ts` — the `kettle:start` GATED row AND the
   `kettle:pause` EXCLUDED row removed per D-080. `pot:pause` stays (D-003).
3. `agent-tools/fleet_registry/pause.ts` — `notWhen` dropped "To pause the Kettle —
   `kettle:pause`". This is GUIDANCE shipped to agents, so a stale pointer is a live wrong
   instruction. It also SHRANK the prompt-weight budget, which is the safe direction.
4. `LeftSidebar.tsx` — the lazy import, the `TABS` entry, the `overwatchOn` flag read, the
   `visibleTabs` gate leg, and the `Thermometer` icon import. **`FLAGS.OVERWATCH` itself is
   NOT removed** — `lib/overwatch/cross-monitor.ts` and the system-action waker still gate
   on it. Only this CONSUMER went.
5. `LeftSidebar.test.tsx` — three flag-gating cases replaced by a retirement tripwire
   (absent with every flag forced on), two order lists, the `TAB_IDS` assertion INVERTED
   (`not.toContain('overwatch')`), and the Agents/System adjacency re-anchored to Mug.
6. **`scripts/ungated-mug-kettle-baseline.json` — FIVE rows dropped.** That baseline is
   keyed `tier|SUBJECT|path` where the subject is *also* derived from the filename, so
   retiring a file desyncs BOTH halves and the row can never match again;
   `mug-kettle-census-dangling-key.test.ts` then fails the shared gate with "every baseline
   entry points at a file that still exists". Dropping SHRINKS the baseline, which its own
   SHRINK-ONLY rule permits. A restore must re-add all five. Rows:
   `tool|kettle:start|…/overwatch/start.ts` · `tool|kettle:pause|…/overwatch/pause.ts` ·
   `wake|setOverwatchStarted|…/overwatch/start.ts` · `wake|setOverwatchStarted|…/overwatch/pause.ts` ·
   `ui|OverwatchTab|apps/operator-vite/src/components/left-sidebar/OverwatchTab.tsx`.
   ⚠ **This step is invisible from inside the slice** — nothing in the moved files points at
   the baseline, so the name-grep D-083 mandates does not find it. Every remaining slice that
   moves a file with a baseline row must drop that row IN THE SAME SLICE. Check with
   `npm run test:file -- packages/operator-core/lib/mug-kettle-census-dangling-key.test.ts`
   (sub-second). Credit: su-863287b8 diagnosed this after the `declare_wake` slice red-pinned
   the gate, and fixed that row.
7. Prose pointers swept in `LeftSidebar.tsx` (the nav-icon note) — cosmetic, listed for
   completeness so a restore's diff is expected to touch them.

**What deliberately did NOT change** (so a restore does not "fix" a non-problem): the many
`kettle:start`/`kettle:pause` mentions in `scorecard-emission-pulse.ts`,
`scorecard-freshness.ts`, `improvements/watchdog.ts`, `cue-authority.ts` and
`lib/overwatch/*` are PROSE or runtime notes belonging to `lib/overwatch/`, a later slice —
except that they are now pointers to verbs that no longer resolve, which is tracked as that
slice's work, not silently accepted here.

## `cup:spawn` — the nursery placement verb (P-059, D-085/D-086)

`packages/operator-core/lib/agent-tools/cup/spawn.ts` + `spawn.test.ts`. Gated at `:163`
(`refuseIfMugKettleRetired`) ⇒ already dead at retirement. **This emptied
`agent-tools/cup/` — the directory is gone, and `cup:spawn` was the last `cup:*` verb, so
that whole tool namespace no longer exists.**

⛔ **`spawnAgentInHarness` (`lib/fleet/operator-spawn.ts`) is NOT retired and must not be
confused with this tool.** It is the shared spawn ENGINE; `cup:spawn` was one of three
doors onto it. The survivors — `capability:launch-agent` and `fleet:launch-on-plan` — call
the same engine and are untouched.

**Live-tree edits a restore must undo — THIRTEEN. Numbers 5–9 are the ones a name-grep of the
moved file does NOT find, because each is a pointer *into* the retired surface; number 13 landed
LATER, after the two invariants below caught what this slice's own verification missed.**

1. `agent-tools/index.ts` — `import './cup/spawn';` (was `:1047`) replaced by a comment. A
   restore that returns the file but not this line silently restores nothing.
2. `agent-tools/mug-kettle-tool-gate.test.ts` — the `cup:spawn` GATED row removed per D-080
   (the restore contract for its flag-ON reversibility is THIS file), and the header's
   "removed so far" list extended.
3. `scripts/ungated-mug-kettle-baseline.json` — **TEN rows dropped** (D-084). Three for the
   moved file (`role-door|spawn|…` · `spawn-role|cup|…` · `tool|cup:spawn|…`) and seven
   `tool|cup:spawn|…papercup/SN*.ts` rows for the scenario asserts removed in #10.
4. `agent-tools/fleet/place_batch.ts` — `replaces: ['cup:spawn','coord:send']` → `['coord:send']`,
   and two `guidance` strings stopped naming the verb. Guidance ships to agents, so a stale
   pointer there is a live wrong instruction (and the edit SHRANK prompt weight, the safe
   direction).
5. **`__tests__/effect-marker-audit.test.ts` — `'cup:spawn'` dropped from `SUFFIX_MUTATORS`.**
   That list `expect(tool).toBeDefined()`s every name at `:69`, so leaving it would have
   **hard-failed the shared gate** on a tool that no longer registers. Nothing in the moved
   file points here.
6. **`dynamic-tool-confinement.ts` — the no-escalation floor.** `'cup:spawn'` was its ONLY
   spawn entry; it was replaced by `capability:launch-agent`, `fleet:launch-on-plan`,
   `fleet:place_batch` rather than deleted, because deleting it would have silently
   NARROWED the floor to nothing on the axis its own header claims ("spawning fleet").
   ⚠ Despite the constant being named `…_CAPABILITY_GLOBS`, its entries are matched as TOOL
   NAMES (`processes:kill`, `tools:scaffold`, `capability:grant_role` are all tools) — an
   entry naming a `capability:` FIELD value would match nothing. `dynamic-tool-confinement.test.ts`
   moved in lockstep (it asserts each floor entry is rejected AND recognised).
7. `autonomy/action-surface.ts` — TWO `queenVerbs: ['cup:spawn']` entries
   (`lifecycle.spawn-agent`, `lifecycle.model-tier`) re-pointed to the surviving doors.
   Re-pointed, not emptied: an empty `queenVerbs` would assert the action surface has NO
   coverage for spawning, which is false.
8. `fleet/operator-spawn.ts:1292` — the decision-ledger `action: 'cup:spawn'` re-keyed to
   `'fleet:spawn-agent'`, which names the ENGINE rather than a retired caller. ⚠ Chosen so
   the category does not move: `^fleet:` hits the SAME `cat:fleet` → `agent-lifecycle` rule
   that `^cup:` did. An UNMAPPED action defaults to never-auto, which would have quietly
   changed autonomy gating.
9. `autonomy/capability-category-map.ts` — the `cat:bee` rule (`^cup:`) **KEPT DELIBERATELY**
   though no `cup:*` verb remains. It is matched against the `action` STRING and the decision
   ledger holds historical rows stamped `cup:spawn`; deleting it would re-categorize those to
   null (never-auto).
10. **Seven `papercup` LLM scenarios** (`SN01`, `SN-D01`–`D03`, `SN-H04`, `H05`, `H07`) — the
    `{ kind: 'tool_not_called', name: 'cup:spawn' }` assert removed from each.
    ⚠ **Do not restore these believing they were coverage.** Measured at retirement, they
    could never fail, for TWO independent structural reasons: `cup:spawn`'s
    `agentRoles: QUEEN_PLACEMENT_ROLES` **excluded `papercup`**, so the verb was never in the
    role's tool surface; and the Sentinel's `<spawn>` tag is guarded
    `if (!isSentinel && parsed.spawns.length)` in `agent-tools/operator/converse.ts`, which
    also calls `spawnAgentInHarness` DIRECTLY rather than the tool, so it could not register
    as a `cup:spawn` call either. They were vacuous BEFORE this retirement, not because of it.
    Re-pointing was considered and rejected: every surviving spawn door is likewise
    unreachable for `papercup`, so any replacement is vacuous in the same way. The contract
    they appeared to carry lives in `emitsHandoff` / `noDelegate` and the judge rubric.
11. Three tests NARROWED, not deleted (D-080 — a shared test keeps its surviving subjects):
    `agent-tools/brief-limit-normalization.test.ts` (its `cup:spawn { brief }` softText case;
    `fleet:place_batch` next to it asserts the same mechanism) ·
    `endpoint-route/routes/transport/bee-tool-boundary.test.ts` (its `CANNOT_ROLE` row; the two
    `gym/*` rows exercise the same two-gate property) ·
    `endpoint-route/routes/transport/role-principal-caps.test.ts` (**TWO** tests — the sentinel
    carve-out test kept its envelope-belt half, the overwatch test kept its `gym:judge` half;
    both were renamed to match what they now assert).
12. Prose pointers swept: `agent-tools/coordination/roles.test.ts` (a PRESENT-tense claim that
    `cup/spawn` imports `QUEEN_PLACEMENT_ROLES`, now false) · `agent-tools/mug-kettle-gate-strands-suite.test.ts`
    (see below) · `libs/papercusp/.../blueprints/coding/blueprint.yaml` (the `- cup:spawn`
    dependency entry) · `libs/papercusp/.../orchestrator/src/invoke.ts:645` (the queen tool kit).
    ⚠ The last two live in the **`libs/papercusp` SUBMODULE** — their restore is a submodule
    commit, not a superproject one.

13. **`operator-mcp-tools.ts` — the `mcp__agentmcp__` chat-surface allowlist entry — AND its
    assertion in `operator-mcp-tools.test.ts`.** ⚠ **This was MISSED by the original slice and
    red-pinned the shared gate.** Naming an unregistered tool in that allowlist is not inert: it
    is a PROMISE to the chat surface that the tool is callable, and it broke two invariants at
    once — `tool-auth-gating` ("every operator-converse allowedTool resolves in the core
    registry") and `tools-md-sync` ("every allowedTool has a catalog entry"). The entry was
    removed first; that alone then broke a THIRD test, `operator-mcp-tools.test.ts:30`, which
    still asserted the entry was PRESENT. It was inverted into a retirement regression guard
    (`does NOT expose the retired cup-spawn nursery verb`), matching the existing work-item-mail
    precedent in that same file, so a re-introduction now fails next to its rationale instead of
    as two mystery reds elsewhere. **A restore must undo BOTH halves** — re-add the allowlist
    entry AND flip that guard back to a presence check, or the guard will fail the restore.
    ⚠⚠ **Do NOT write the full `mcp__agentmcp__` + `cup:spawn` token anywhere in
    `operator-mcp-tools.ts`, even in a comment saying it was removed.** `tools-md-sync` builds
    the allowlist by regexing that file's source text (`allowedToolsSource`), and a regex cannot
    tell a live contract from prose about one — a comment mentioning the prefixed name silently
    re-adds the tool. The token IS safe in the test file: nothing harvests it.

⚠ **`mug-kettle-gate-strands-suite.test.ts`'s dynamic-import arm lost its only real subject.**
Its comment cited `cup/spawn.ts` as proof the dynamic `await import('…/_mug-kettle-gate')`
form was "not hypothetical". Measured after this slice: **every** surviving gated tool
(`pot/{start,wake,declare_wake,mug_efficiency,set_steering}`) imports the gate STATICALLY, so
that arm now matches nothing in-tree. The arm was KEPT and the comment rewritten to say so —
a detector that only recognises the form today's files happen to use is how the original
false negative happened. Restoring `cup/spawn.ts` makes the claim live again.

**What deliberately did NOT change:** `agent-tools/coordination/roles.ts`'s historical note
still lists `cup/spawn` among the ~10 files that once re-spread the inline role filter — that
is an explicitly PAST-tense claim and remains true. The `cup:spawn` literals in
`operator-sentinel-handoff.test.ts` / `operator-converse-tags.test.ts` are `<handoff_to_mug
capability="…">` TAG-ATTRIBUTE fixtures (an opaque approval key, a different namespace), and
the `llm-testing/targets/{mug,overwatch}.ts` bait tool-defs + the `OW01`/`OW02` scenarios are
self-contained in the test harness rather than resolved against the live catalog — those
belong to the `lib/overwatch/` slice, per the precedent set for `kettle:declare-wake`.

## `bee-transcript-cap` — the transcript-cap backstop sweep (P-059, D-090)

**FOUR files**, the decider and the routine that was its sole consumer:

| file | original path |
|---|---|
| `cup-transcript-cap.ts` (+ test) | `packages/operator-core/lib/pot/` |
| `bee-transcript-cap-action.ts` | `packages/operator-core/lib/harness/routines/` |
| `seed-bee-transcript-cap-routine.ts` | `packages/operator-core/lib/harness/routines/` |

`cup-transcript-cap.ts` had **exactly one non-test importer at retirement** —
`bee-transcript-cap-action.ts`, the `system:bee-transcript-cap` routine handler, which
retired with it. So this is a whole feature leaving, not an orphaned module.

⚠ **D-090 SPLIT ITS SIBLING OFF THIS SLICE.** `pot/cup-wake-efficiency.ts` sits in the same
directory, shares the `cup-` prefix, and was consumed by this same routine — and it **STAYS**.
It has live consumers outside the tier (`pot-eval/live-ops.ts` → `pot-eval/index.ts`, plus four
`external-bench/` harnesses), and its `spawn-role|cup|…cup-wake-efficiency.ts` baseline row
stays with it. A restorer must not read "the transcript-cap slice" as covering both files: the
test is per-file (*who imports this, and does that consumer survive?*), never the shared prefix.

**The routine row was never seeded.** `harness_shared.routines` held **no** `bee-transcript-cap`
row at retirement — verified against a checked denominator (477 routines / 218 active), so
retiring the handler orphaned no scheduled work. A restore must therefore run
`seed-bee-transcript-cap-routine.ts` (it seeds INACTIVE) or the sweep will never fire, exactly
as it never did.

**Live-tree edits a restore must undo — EIGHT. Numbers 4–8 are pointers *into* this surface that
a name-grep of the moved files does NOT find.**

1. `harness/routines/register-system-actions.ts` — `import './bee-transcript-cap-action';`
   (was `:374`) replaced by a comment. Restoring the files without this line registers nothing.
2. `libs/flags/src/types.ts` — `CUP_TRANSCRIPT_CAP: "papercusp-bee-transcript-cap"` removed.
   ⚠ It was **DEFAULT-ON and never in `DARK_FLAGS`**, so removing it parks no dark debt and a
   restore must NOT add an allowlist entry — re-add the key alone. (The sweep was still
   double-gated: this flag AND the routine's own `active` column.)
3. `scripts/ungated-mug-kettle-baseline.json` — **TWO rows dropped** (D-084):
   `spawn-role|cup|…bee-transcript-cap-action.ts` and
   `system-action|bee-transcript-cap|…bee-transcript-cap-action.ts`.
4. `automation/routine-classification.ts` — the `'system:bee-transcript-cap'` spend row (`:349`)
   AND `^bee-transcript-cap$` dropped from `CLEANUP_FAMILY` (`:514`). ⚠ Both are keyed on the
   routine NAME STRING, so neither dangles a symbol — but leaving them classifies a routine that
   cannot exist, and an UNCLASSIFIED routine falls to a different default.
5. `agent-tools/routines/set.ts` — TWO `guidance`/`describe` strings stopped citing
   `the bee-transcript-cap caps max_tasks / max_carried_read_tokens / max_transcript_entries`
   as the worked example, now `the claim-discipline throttle_min, or a reaper dry_run`. Guidance
   ships to agents, so a stale pointer is a live wrong instruction. ⚠ Both replacements are
   SHORTER: `lint:tool-prompts` headroom was 2 chars (p99 1493 / max 1498 vs budget 1500), so a
   restore that puts the longer text back must re-run that lint before landing.
6. `agent-tools/routines/routines.test.ts:370` — the trigger_config-merge fixture was re-pointed
   off this routine to `claim-discipline` + its real `throttle_min` knob (D-088 triage: a mocked
   name string, not a dependency — but a fixture naming a nonexistent routine reads as coverage).
7. `su-cold-loop.ts:50,56` — the `ColdLoopCaps.recycleEveryNWakes` provenance comments. ⚠ The
   cold-loop **PORTED** the maxTasks-8 recycle cadence; it never imported it. The comments were
   re-pointed here, not deleted, because the default's origin is the reason it is 8.
8. `harness/routines/work-intake-action.ts:17` — the "per-routine `triggerConfig` convention"
   example list, re-pointed to two live siblings.

**What deliberately did NOT change:** `docs/mug-kettle-surface-census.json` and
`docs/pot-substrate-split-census.json` still name these paths. Both are **dated point-in-time
survey artifacts** (`generatedAt` 2026-08-09, `item: P-005`), not live indexes — no test or
package script enforces them (`verify-pot-substrate-ast.mjs` is a manual CLI). Rewriting a dated
survey to match a later tree would falsify the record it exists to preserve. Likewise the
`scratchpad/lexicon-audit-2026-07-09/*` inventories and `junit.xml`.

<!-- Later P-059 slices append rows here. Keep the "why it retired" column
     evidence-bearing (importer count at retirement), not just a restatement
     of the file name. -->

## Do not

- Do not extend or test anything here — it is outside the workspace globs, so npm,
  the affected-test runner, knip and nx do not see it (root `_retired/README.md`).
- Do not move retired TypeScript into `packages/operator-core/lib/_retired/`
  instead. That path is **inside** `operator-core`'s `include: ["lib/**/*.ts"]`, so
  code there is still typechecked and is not retired in any meaningful sense — see
  **D-075**. Only this root `_retired/` is outside the build.
