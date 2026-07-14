# Mug/Kettle rail tabs (queen + overwatch) — retired 2026-07-14 (WI-4778)

The left-rail **Mug (queen) steering tab** and **Kettle (overwatch) supervisor
tab**, retired by owner decision [owner:Avi 2026-07-14]: *"I don't like there
being a kettle and mug chat at all … the whole point of papercup was to give
the user a single persona"*. Papercup is the one persona; the Mug/Kettle
**decision inputs** the owner still wants to SEE render in the operator chat
sidebar's full-height **Pot Health view** (`PotHealthPane`, toggled by the 🫖
header button / `?opcv=pot`).

## What moved here (from `apps/operator-vite/src/components/left-sidebar/`)

- `MugTab.tsx` (+ `MugTab.test.tsx`, `MugTab.derivation.test.ts`,
  `MugTab.tree.test.tsx`) — the owner's Queen steering panel
  (queen-steering-panel-2026-06-15 B-04): pause new work, focus directive,
  eligible hives/plans, scheduled routines.
- `OverwatchTab.tsx` (+ test) — the Kettle loop control (start/pause) + the
  anomaly→action list (system-health-tab-2026-06-15 P-008).
- Sub-components used only by those two: `MugHeartbeat`, `ModelTiersOverride`,
  `ThrottleSection`, `AutonomySurfacing`, `HiveSteeringTree`,
  `hive-steering-tree.ts` (+ tests).

## What did NOT move (still live)

- `ModelOverride.tsx` + `useModelOverride.ts` — also used by the live
  `PapercupTab`.
- `resolveHomeHive` — extracted to
  `apps/operator-vite/src/components/left-sidebar/resolve-home-hive.ts`
  (the live `useModelOverride` needs it). `MugTab.tsx` here still carries its
  original copy.
- The `left-sidebar.styles.ts` panel CSS blocks (`pc-owsb`, `pc-mt`, `pc-mhb`,
  throttle/autonomy) — left in place because the live PapercupTab consumes the
  shared `pc-queen__*` primitives interleaved with them.

## Capability note

The steering WRITE surfaces these tabs carried (pause/directive/eligible
plans+hives/model tiers/throttle/kettle start-pause) have no other GUI — the
owner steers by talking to Papercup (the persona drives `pot:set-steering` /
`kettle:start|pause` tools). The Pot Health view shows steering state
read-only.

## Restore

1. Move the files back into `apps/operator-vite/src/components/left-sidebar/`.
2. Re-add the two TABS entries + lazy imports + `Coffee`/`Thermometer` icons +
   the OVERWATCH flag gating in `LeftSidebar.tsx` (see git history of WI-4778,
   which removed them in one commit), and restore the queen/overwatch
   `--pclsb-tab-accent` rules in `left-sidebar.styles.ts`.
3. Point `MugTab.tsx`'s `resolveHomeHive` at `./resolve-home-hive` (or keep its
   local copy and delete the extracted module).
4. Update `LeftSidebar.test.tsx` tab expectations back.
