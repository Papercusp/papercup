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
