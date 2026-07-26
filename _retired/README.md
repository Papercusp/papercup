# `_retired/` — preserved-not-active code

Code in this directory is **retired but deliberately kept** for reference. It is:

- **not** an npm workspace (it lives outside the `apps/*` / `packages/*` globs, so
  npm, the affected-test runner, knip, and nx do not treat it as live),
- **not** built, deployed, or tested,
- **not** to be extended or imported by active code.

Do not add features or write tests here. See each subdirectory's `RESTORE.md` for
how to bring a surface back, and the root `CLAUDE.md` →
"Retired / preserved-not-active surfaces" for the full roster + the retire/restore
convention.

## Contents

- `papercup/` — `@papercup/web`, the former papercupai.com public site. Retired
  2026-05-30. Restore: see `papercup/RESTORE.md` (git tag
  `papercup-web-retired-2026-05-30`).
- `orchestrator-run-loop/apps-operator-test/` — the 4 superproject-side integration
  tests for the legacy orchestrator PG modules, retired alongside the modules
  themselves (which live in the **papercusp submodule** at
  `libs/papercusp/_retired/orchestrator-run-loop/`). Retired 2026-06-06
  (`archive-legacy-orchestrator-deadcode`). Restore:
  `orchestrator-run-loop/RESTORE.md`.
- `snapshot-system/` — the whole harness-snapshot system (`@papercusp/export-state`
  FS-tarball lib + `snapshots:*` tools + `/api/snapshots/*` routes + the Cupboard
  `kind=snapshot` path + the worker R2 blob store + the snapshot UI). Retired
  2026-06-09 (`retire-snapshots-instance-spec`); the reproducible clone re-homed onto
  the lightweight `InstanceSpec` (`packages/operator-core/lib/instance-spec/`).
  Restore: `snapshot-system/RESTORE.md` (git tag `snapshot-system-retired-2026-06-09`).
- `legacy-web-chats/` — the in-webview chat surfaces (OracleDock,
  OperatorChatSidebar, OperatorChat, TutorialButton); the terminal-native pui
  chat pane is the only chat surface. Retired 2026-07-09
  (design-simplification-2026-07-09 P-003, owner decision D1). Restore:
  `legacy-web-chats/RESTORE.md`.
- `harness-dashboard/` — the legacy per-slug harness dashboard (`/harness/$slug`
  dock shell + insights/projects pages, the Real*/Pinned* dock panels +
  `sample-panels` registration set, orphaned dashboard tabs, the legacy vite
  routes, `e2e/dock.spec.ts`). Retired 2026-07-09
  (design-simplification-2026-07-09 P-008, owner decision D2). The design-system
  primitives + the dock ENGINE in `apps/operator/app/harness/` stay live — `/adv`
  and `/workbench` are built on them. Restore: `harness-dashboard/RESTORE.md`.
- `mug-kettle-rail-tabs/` — the left-rail Mug (queen) steering tab + Kettle
  (overwatch) supervisor tab and their private sub-components (MugHeartbeat,
  ModelTiersOverride, ThrottleSection, AutonomySurfacing, HiveSteeringTree).
  Retired 2026-07-14 (WI-4778, owner decision: Papercup is the ONE persona —
  no Mug/Kettle surfaces; their decision INPUTS render in the chat sidebar's
  full-height Pot Health view instead). `ModelOverride`/`useModelOverride`
  stay live (PapercupTab), `resolveHomeHive` extracted to
  `left-sidebar/resolve-home-hive.ts`. Restore: `mug-kettle-rail-tabs/RESTORE.md`.
- `inbox-pane/` — the chat sidebar's human Inbox face (`InboxPane.tsx`, `?opcv=inbox`).
  Retired 2026-07-26 (`hud-consolidation-2026-07-26` D-001, owner decision: every
  ask it surfaced now opens as a HUD conversation instead, gated on P-002 first
  proving the HUD covers ownerless asks too). The data layer
  (`use-inbox-pending.ts`) stays live — the HUD board consumes it directly.
  Restore: `inbox-pane/RESTORE.md`.
