---
title: PSU wrappers + plan-tracked terminal launch
slug: psu-wrappers-and-plan-tracked-launch-2026-05-30
status: ready
created: 2026-05-30
updated: 2026-05-30
---

# PSU wrappers + plan-tracked terminal launch

## Now

**State:** Plan drafted; awaiting human review of scope/sequence before Phase A code starts.

**Next:** human confirms phase ordering and the open questions in Decisions, then we kick off Phase A (rename + codex wrapper + bootstrap endpoint).

## Background

Today the only SU agent wrapper installed by Papercusp is `omp-su`. It is
auto-installed on desktop boot via three call-sites
(`instrumentation-node.ts`, `bin/host-bootstrap.ts`,
`lib/endpoint-route/routes/agent-mcp/console-launch.ts`) and surfaced in the
operator at `/settings/omp-integration`. Claude Code and Codex are both
first-class MCP clients of `papercusp-su`, but neither has a wrapper
counterpart — Claude Code only gets the bash-installer path
(`apps/operator/scripts/install-standalone-mcp.sh`), and Codex has nothing.

Separately, agents launched from `/adv` are tracked as `plan_runs` /
`spawns` so they show up in the Sessions tab and can be resumed. Wrappers
launched from a terminal today produce **untracked** sessions — they just
exec the CLI with the engineer-collaborator playbook appended, with no
server bookkeeping. This means terminal SU work is invisible to /adv.

This plan unifies the three CLI agents under a `*-psu` naming scheme
(papercusp-su), gives every wrapper the same plan-or-NO-PLAN picker UX
on launch, registers wrapper-launched sessions as real `plan_runs` (or
no-plan `spawns`) so they appear in /adv, and retires the desktop-boot
auto-install in favour of per-harness settings. Once shipped, opening a
terminal and typing `claude-psu` will produce the same tracked,
playbook-flavoured agent as clicking "Launch SU engineer" in /adv.

### Design constraints

- **Global wrappers, not per-harness binaries.** Three wrappers total
  (`claude-psu`, `omp-psu`, `codex-psu`) that prompt for harness on
  launch. Harness-settings install action *registers* the harness
  with the wrapper's known-harness list rather than dropping new
  binaries per harness. (Decision D-001.)
- **Picker stack: `@inquirer/prompts`.** Node is already a hard
  prerequisite for all three agents; using inquirer's `search` widget
  costs zero new install footprint and gives live fuzzy search. (D-002.)
- **Wrappers become Node scripts**, not bash, so they can share types
  with the operator code and own the picker logic directly. The
  on-PATH `claude-psu`/`omp-psu`/`codex-psu` are tiny shebang shims
  that `exec node ~/.papercusp/psu-launcher.mjs --agent=<kind> "$@"`.
  (D-003.)
- **Bake in the per-CLI "skip permissions" flag** so wrapper users
  never have to re-type it. Verify the current flag for each CLI at
  build time against the installed binary. (D-004.)
- **No-plan launches still create a DB row** (a `spawn` with
  `plan_id: null`) so they're visible in /adv Sessions tab under a
  "No plan" heading. (D-005.)
- **Hard rename, no aliases.** Old `omp-su` / `claude-su` binaries
  are actively deleted by the installer; no deprecation symlinks.
  Per pre-alpha-freedom rule — no users yet, break things now. (D-006.)
- **Retire desktop-boot auto-ensure entirely** once per-harness
  install is shipped. Wrappers come from a deliberate per-harness
  settings action, not a silent boot hook. `/settings/omp-integration`
  is deleted, not renamed. (D-007.)

## Phase A — Foundation (rename + codex + bootstrap endpoint)

P-001 todo Rename `apps/operator/lib/omp-su-wrapper.ts` template into per-agent files under `apps/operator/lib/wrappers/` (`omp-psu-wrapper.ts`, `claude-psu-wrapper.ts`, `codex-psu-wrapper.ts`). Each exports its wrapper-shim template constant.
P-002 todo Rename `apps/operator/lib/ensure-omp-su.ts` to `apps/operator/lib/ensure-psu-wrappers.ts`; single function ensures all three wrappers plus the shared launcher script. Self-healing fallback retained for `console-launch.ts` only (boot-site callers retire in Phase D).
P-003 todo Update `apps/operator/scripts/install-standalone-mcp.sh`: write new `*-psu` wrappers, hard-delete any legacy `~/.local/bin/omp-su` or `~/.local/bin/claude-su` if present, update help/revoke text, refresh installed playbook copy.
P-004 todo Verify Codex CLI flags against the installed `codex` binary: confirm `--system`-style prompt injection, the current "skip confirmation" flag (`--full-auto` or its successor), and whether Codex consumes HTTP MCP via `~/.codex/config.toml` `mcpServers` entries. Document findings as a Decision once verified.
P-005 todo Add Codex MCP merge step to `install-standalone-mcp.sh` symmetric to the existing Claude / OMP merges. Includes `.bak.<timestamp>` defensive backup on parse failure.
P-006 todo New endpoint `POST /api/agent-mcp/console/bootstrap-su` at `apps/operator/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts`. Inputs `{ harness_slug, agent: 'claude'|'omp'|'codex', plan_slug: string | null }`. Returns `{ runId?, spawnId, sessionId, envelopeEnv: Record<string,string>, playbookPath: string, cliFlags: string[] }`. Reuses HMAC-signing logic from `console-launch.ts`. Creates a `plan_run` row when `plan_slug` is set, a `spawn` row with `plan_id: null` otherwise. Emits audit row + Zero delta. blocked-by:P-004
P-007 todo Unit tests for `bootstrap-su.ts`: plan_slug=set → plan_run created and referenced; plan_slug=null → spawn with plan_id=null; envelopeEnv contains expected MCP/HMAC keys; cliFlags vary by agent kind.

## Phase B — Terminal UX (Node launcher with picker)

P-010 todo New `apps/operator/lib/wrappers/psu-launcher.mjs` (Node ESM script, installed to `~/.papercusp/psu-launcher.mjs`). Uses `@inquirer/prompts` (`select`, `search`). Adds `@inquirer/prompts` to `apps/operator/package.json` as a runtime dep. blocked-by:P-006
P-011 todo Launcher flow: (a) harness picker (search widget over `papercusp:list_workspaces` × `harness:list`), (b) plan picker (search widget over `plans:list` for chosen harness, prepended with a literal "▸ NO PLAN — ad-hoc SU session" row), (c) POST `bootstrap-su` with picks, (d) exec underlying CLI with returned `envelopeEnv` + `--append-system-prompt-file <playbookPath>` + agent-appropriate skip-permissions flag from `cliFlags`. blocked-by:P-010
P-012 todo Scripting escape: `--no-picker --harness=<slug> [--plan=<slug>|--no-plan]` skips prompts and exec's directly. Required for shell scripts and CI uses. blocked-by:P-011
P-013 todo Wrapper shims (the three on-PATH binaries) become `#!/usr/bin/env bash` one-liners: `exec node "$HOME/.papercusp/psu-launcher.mjs" --agent=<kind> "$@"`. Templates live at `apps/operator/lib/wrappers/{claude,omp,codex}-psu-wrapper.ts`. blocked-by:P-011
P-014 todo Bake skip-permissions flags per agent into `cliFlags` returned from `bootstrap-su`: claude → `--dangerously-skip-permissions`, codex → flag verified in P-004, omp → current "no-confirm" / "yolo" equivalent. Verify each against the installed binary at install time and emit a console warning if mismatched. blocked-by:P-006,P-004
P-015 todo Manual e2e: `claude-psu` from a fresh terminal in a non-papercup cwd → picker shows known harnesses → pick papercup → picker shows live plans → pick one → claude opens with playbook + tracked plan_run visible in /adv Sessions tab. Repeat for omp-psu and codex-psu. Repeat with NO PLAN → spawn row created with plan_id=null. blocked-by:P-013,P-014

## Phase C — Web UX (/adv "Launch SU" + Sessions tab grouping)

P-020 todo Add "Launch SU engineer" button to the Sessions tab in `apps/operator/app/admin/plans/PlansClient.tsx` or `apps/operator-vite/src/components/adv/`. Opens a modal that picks `{ agent, plan_or_no_plan }` and hits `bootstrap-su` with `plan_slug: null` when no-plan is chosen. Server then spawns the agent process through the orchestrator path (NOT a raw exec — this is in-app, not terminal). blocked-by:P-006
P-021 todo Add "No plan" group at the top of the Sessions tab listing all `spawn` rows with `plan_id: null`. Rows show agent kind, started-at, status, owner. Re-uses existing session-row component. blocked-by:P-020
P-022 todo Wire whatever sync surface backs Sessions (Zero / SSE / poll) to refresh when a wrapper-bootstrapped session lands. Spec: a `claude-psu` launch in a terminal should appear in /adv Sessions within ~2s without a manual refresh. blocked-by:P-006,P-021
P-023 todo Manual e2e: launch via /adv "Launch SU (no plan)" → row appears under "No plan"; launch via `claude-psu --no-plan` → same row appears under "No plan" from a different origin. blocked-by:P-022,P-015

## Phase D — Retire desktop-boot install + move to per-harness settings

P-030 todo Delete `ensureOmpSuInstalled()` invocation from `apps/operator/instrumentation-node.ts` and `apps/operator/bin/host-bootstrap.ts`. Leave the self-heal call inside `lib/endpoint-route/routes/agent-mcp/console-launch.ts` (covers in-app launches that arrive before per-harness install has been run). blocked-by:P-040
P-031 todo Delete `apps/operator/app/settings/omp-integration/page.tsx` and the vite copy at `apps/operator-vite/src/routes/settings/omp-integration.tsx`. Delete sidebar entries. Grep for inbound links and update. blocked-by:P-040
P-032 todo Audit-grep for `ensure-omp-su` / `omp-integration` references and delete dead imports / routes / docs. blocked-by:P-031
P-040 todo New per-harness "Terminal wrappers" panel under the existing harness Settings tab. Detects installed CLIs (claude, omp, codex on PATH via shell check), shows install/refresh/remove buttons per CLI, links to the "Launch from terminal" docs page. Calls a new endpoint `POST /api/desktop/install-psu-wrappers { agents: ['claude','omp','codex'] }` that runs the same ensure logic the bash installer does. blocked-by:P-003,P-013
P-041 todo Docs page at `apps/operator-docs/src/content/docs/agent-spawning/terminal-wrappers.mdx` explaining `*-psu` wrappers, picker flow, scripting escape, and the per-harness install action. Add to sidebar via Starlight frontmatter `sidebar.order`. blocked-by:P-040
P-042 todo Migration note: any machine with auto-installed `omp-su` wrappers still gets them renamed/refreshed once because P-030 / P-031 / P-032 leave the `console-launch.ts` self-heal in place. Document this in the docs page (P-041) so users aren't surprised when the binary disappears. blocked-by:P-041

## Cross-cutting / non-phase items

P-050 todo Update `AGENTS.md` § "Papercusp engineer-collaborator tool playbook" to reference `*-psu` instead of `omp-su` / `claude-su`. Single search-and-replace plus a short note that wrappers now prompt for plan/harness. blocked-by:P-013
P-051 todo Update `apps/operator/prompts/papercusp-su-engineer.tools.md` (the playbook source) same way. Re-run `install-standalone-mcp.sh` after edit to refresh installed copy. blocked-by:P-050
P-052 todo Memory updates: forget the `[Mac VM systemd kill loop]`-adjacent entry that mentions `omp-su` install paths only (if any); save a new memory documenting that `*-psu` is the wrapper family and that wrapper-launched sessions are tracked. blocked-by:P-040

## Decisions

### D-001 — Global wrappers with a harness picker, not per-harness binaries

**Date:** 2026-05-30

Per-harness wrappers (`claude-psu-<slug>` × 3 × N harnesses) would
proliferate binaries on PATH and confuse the install/uninstall story.
Global wrappers with an interactive harness picker keep the PATH clean
and let one wrapper serve every harness on the machine. Per-harness
"install" becomes registration with the wrapper's known-harness list,
not a new binary. Picker can be skipped with `--harness=<slug>` for
scripting.

### D-002 — Plan/harness picker uses `@inquirer/prompts` `search`

**Date:** 2026-05-30

Considered fzf (fast, ubiquitous on dev machines, external dep) and
Bubble Tea (rich TUI substrate, ~1-2 days build, opens room for
preview pane / live status / inline actions later). Chose inquirer for
v1 because Node is already a hard prereq for all three CLI agents
(zero new install footprint), the `search` widget gives live fuzzy
filtering, and TypeScript types can be shared with the operator code.
Reconsider Bubble Tea if/when the picker grows into a richer terminal
companion (preview pane, multi-select, attach-to-running-session).

### D-003 — Wrappers are Node ESM scripts behind a tiny bash shim

**Date:** 2026-05-30

The on-PATH `claude-psu` / `omp-psu` / `codex-psu` files are
`#!/usr/bin/env bash` one-liners that `exec node ~/.papercusp/psu-launcher.mjs --agent=<kind> "$@"`.
This keeps the install artifact identical to today (a small shell file
in `~/.local/bin/`) while putting the real launcher logic in a Node
script that can import operator types, use inquirer, and call the
operator HTTP API directly. Avoids reimplementing the picker in bash
and avoids forcing every machine to install a separate launcher binary.

### D-004 — Skip-permissions flag baked in, verified at install time

**Date:** 2026-05-30

Wrapper users should never have to re-type
`--dangerously-skip-permissions` (or its per-CLI equivalent). The
launcher appends the flag automatically based on the agent kind. Flag
names drift across CLI releases, so the install step probes the
installed binary's `--help` output for the expected flag and emits a
console warning if a mismatch is detected. Per-agent flag list lives
in one map in `psu-launcher.mjs` for easy maintenance.

### D-005 — No-plan launches create a `spawn` row with `plan_id: null`

**Date:** 2026-05-30

Originally considered making no-plan launches fully ephemeral (env
only, no PG). Rejected because the /adv "Launch SU (no plan)" surface
needs *something* to display, and consistency between
terminal-launched and /adv-launched no-plan sessions matters more than
saving one row per launch. Sessions tab gets a "No plan" group at top.
Rows show agent kind, started-at, status, owner, and are resumable
exactly like plan-bound rows.

### D-006 — Hard rename `*-su` → `*-psu`, delete legacy on install

**Date:** 2026-05-30

Per pre-alpha freedom (no users, no production), no deprecation
aliases or symlinks. The installer actively deletes leftover
`~/.local/bin/omp-su` and `~/.local/bin/claude-su` if they exist so
nobody ends up with a stale wrapper pointing at a deleted playbook
path. Docs and AGENTS.md are search-and-replaced.

### D-007 — Retire desktop-boot auto-ensure entirely

**Date:** 2026-05-30

The `ensureOmpSuInstalled()` boot hooks were a convenience that
masked which CLIs a user actually wanted. Per-harness settings make
the install deliberate: a user adds a harness, sees a "Terminal
wrappers" panel, picks the CLIs they use. The `console-launch.ts`
self-heal call stays so in-app launches still work on a fresh machine.
`/settings/omp-integration` is deleted, not renamed — its successor
is per-harness, not global.

