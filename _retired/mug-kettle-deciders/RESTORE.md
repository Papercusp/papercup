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
