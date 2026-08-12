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
   `kettle:start` stays in `GATED` and `kettle:pause` stays in `EXCLUDED` — both tools are
   still live as of this slice.
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
