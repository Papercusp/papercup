---
title: psu-only launch unification — retire the *-su wrappers, one launch spec for su + roles
slug: psu-only-launch-unification-2026-05-31
status: active
created: 2026-05-31
updated: 2026-05-31
---

# psu-only launch unification — retire the *-su wrappers, one launch spec for su + roles

## Now

**State:** Phases 0-1 done.

**Next:** P-020: psu su-flow to builder; codex gated.

## Background

`agent-launch-unification` made `psu`/`launchAgent` the one dispatch for every
backend and converged the orchestrator + role + (P-032) omp launch paths. The
last asymmetry: **`su` (the engineer-collaborator) still launches via the
install-baked `*-su` shell wrappers**, while every pipeline role assembles its
prompt + MCP config per-launch via `buildRoleLaunchSpec`.

The design realization (D-001): **`su` is not a different mechanism — it is
`buildLaunchSpec` with two parameters changed.** A launch is always: compose a
system prompt → resolve cwd → mint an MCP config → record the session → exec the
raw CLI. `su` differs from a role only in (a) prompt source = the playbook
(`papercusp-su-${profile}.tools.md`) instead of `prompts/<role>.md`, and (b) tool
scope = superuser (`?superuser=1`) instead of a signed role-scoped URL. Both are
arguments to the same function.

The ONLY thing that ever justified the install-baked wrappers was
**operator-independent direct use** (typing `claude-su` with no operator
running). The user is retiring that path — every launch goes through `psu` (which
already hits the operator) — so the wrappers lose their reason to exist, and the
playbook can be assembled per-launch (killing the install-bake/boot-refresh
staleness surface entirely).

End state: **one launch mechanism** — `psu` → `buildLaunchSpec` → raw CLI — for
`su` AND roles. `psu`'s `roleLaunchArgs` already launches raw `claude`/`omp`/
`codex` with a composed prompt file + `.mcp.json`/CODEX_HOME + skip-perms; the
wrappers' remaining jobs (playbook, superuser MCP, lock hooks, omp coord `-e`,
SID) get absorbed into `buildLaunchSpec` + psu's launch args. The installer
shrinks to: install `psu` + the superuser token + the source playbooks + MCP
registration; psu mints per-session everything.

**Reference:** `agent-launch-unification-2026-05-30` (parent arc) +
`agent-launch-unification-e2e-handoff-2026-05-31` (verification ledger — how psu
role launches + `writeRoleCodexHome` work). Key code:
`apps/operator/lib/role-launch-spec.ts` (`buildRoleLaunchSpec`);
`apps/operator/scripts/psu-launcher.mjs` (`roleLaunchArgs`, SU flow,
`resumeArgsFor`, `SU_WRAPPER_BIN`);
`apps/operator/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts` +
`bootstrap-role.ts`; `apps/operator/lib/role-codex-home.ts`
(`writeRoleCodexHome`); `apps/operator/scripts/install-standalone-mcp.sh`
(wrapper installs §4d/4e/4f + playbook render + hooks).

## Phase 0 — Discovery & inventory (do before touching anything)

- **P-001** `done` Audit every reference to `claude-su`/`omp-su`/`codex-su` across the repo (scripts, `lib/**`, docs, prompts), `~/.claude.json`, the installer, and PATH shims; classify each as psu-internal (`SU_WRAPPER_BIN`, `resumeArgsFor`, `bootstrap-su` `wrapperBin`, `launch-su`) vs external (docs, user habit) → produce a kill-list + a "must re-home" list. (Audited — refs classified below in Now. Only claude-su installed on this box omp-su/codex-su absent; papercusp-su MCP in ~/.claude.json.)
- **P-002** `done` Inventory what each wrapper injects that psu must reproduce: (a) playbook prompt source + profile (engineer/power); (b) superuser MCP config (claude `~/.claude.json` papercusp-su, omp path-discovered `.mcp.json`, codex CODEX_HOME `config.toml` + `PAPERCUSP_SU_TOKEN` bearer); (c) lock-enforcement hooks (claude user-level `settings.json` — survives raw launch; codex scoped `codex-su` CODEX_HOME `settings.json` — MUST re-home; omp `-e papercusp-coord.ts`); (d) `PAPERCUSP_SID`; (e) skip-perms/approval flags. Confirm the claude-survives / codex-doesn't asymmetry empirically. (Confirmed live: claude MCP + lock hooks are USER-level survive raw claude → claude is trivial; codex hooks are scoped to codex-su-home/settings.json P-030 must re-home; omp needs -e coord. Details in Now.)

## Phase 1 — buildLaunchSpec (generalize the spec)

- **P-010** `done` Generalize `buildRoleLaunchSpec` → `buildLaunchSpec({ kind:'su'|'role', agent, workspaceId, harnessSlug?, profile?, role?, featureId?, planContext? })`. `kind:'role'` stays byte-identical (signed role-scoped URL + `prompts/<role>.md`); `kind:'su'` uses prompt=playbook, cwd=harness projectDir or workspace root, MCP=superuser (D-002). blocked-by: P-002 (buildLaunchSpec{kind:'su'|'role'} in role-launch-spec.ts; role delegates byte-identical, su branch new. 5 unit tests.)
- **P-011** `done` Playbook-as-prompt, single-sourced: su's per-launch prompt reuses the SAME renderer the installer/boot path uses (`splice-tooling-overlay`/`papercusp-files`) over `prompts/papercusp-su-${profile}.tools.md` + the per-agent overlay, so the (now-removed) install-baked file and the launch-assembled prompt can't drift; layer the launch-context addendum (harness scope + bound-plan Now) the way `bootstrap-su` does today. blocked-by: P-010 (su prompt via renderSuPlaybook shared splice over prompts/papercusp-su-<profile>.tools.md + papercusp-su.<agent>.md + composeLaunchContext addendum; install path refactored onto the same overlay reader no drift.)
- **P-012** `done` Superuser MCP minting for `kind:'su'`: write a per-session `.mcp.json` (claude/omp) / CODEX_HOME `config.toml` (codex) at `?superuser=1&client=<SID>` + the `PAPERCUSP_SU_TOKEN` bearer (D-002) — a sibling branch to the role path's signed-URL minting, one `if` not a parallel module. blocked-by: P-010 (su MCP = loopback ?superuser=1&workspace=<ws> + bearer via shared readSuperuserToken exported from superuser-token.ts; matches console-launcher .mcp.json shape.)

## Phase 2 — psu SU flow → spec + raw-CLI launch

- **P-020** `wip` psu: route the plain-SU flow through `buildLaunchSpec({kind:'su'})` + raw-CLI launch args (mirror `roleLaunchArgs`), dropping the `SU_WRAPPER_BIN` exec — claude `--append-system-prompt-file <playbook+ctx> --mcp-config <superuser.json> --dangerously-skip-permissions --permission-mode bypassPermissions` (D-004: maybe NOT `--strict-mcp-config`); omp `--approval-mode yolo --append-system-prompt <file> -e <coord.ts>`; codex CODEX_HOME (AGENTS.md=playbook+ctx, config.toml=superuser MCP, +lock hooks, +auth symlink) `--dangerously-bypass-approvals-and-sandbox`. blocked-by: P-012, P-002 (Pure suLaunchArgsbackend,{promptFile,mcpJsonPath,coordExtPath} landed + 5 tests D-005 resolves D-004: no --strict-mcp-config. REMAINS: bootstrap-su returns buildLaunchSpecsu spec, psu execs raw CLI not wrapper, codex CODEX_HOME P-030 gate — these flip the LIVE launch + need P-031/P-032 live verification; held for a supervised session.)
- **P-021** `todo` Carry the omp coordination extension (`-e ~/.papercusp/papercusp-coord.ts`) into psu's omp launch args for BOTH su and role omp launches (role omp currently lacks it — pre-existing gap this closes). blocked-by: P-020
- **P-022** `todo` Mint `PAPERCUSP_SID` per psu launch (su + role) and export it in `envelopeEnv` so coord/lock owner identity is per-session (replaces the wrapper's SID minting). blocked-by: P-020
- **P-023** `todo` `psu --profile=engineer|power` (default = a stored default) now that the playbook is assembled per-launch — replaces the per-install `--profile` choice for su sessions. blocked-by: P-011

## Phase 3 — Coordination / lock-hook preservation (HARD GATE)

- **P-030** `todo` Extend the codex per-session CODEX_HOME builder (`writeRoleCodexHome` + the su equivalent) to install the SU-locks Pre/PostToolUse hooks (`settings.json` in the CODEX_HOME) + `--dangerously-bypass-hook-trust`, so per-session codex keeps the lock enforcement the static `codex-su` home provided. blocked-by: P-002
- **P-031** `todo` GATE — verify lock enforcement live on all three agents launched via psu (no wrapper): edit a locked file from a psu claude/omp/codex session and confirm the PreToolUse lock hook acquires/blocks exactly as before. NO wrapper deletion until green. blocked-by: P-030, P-020, P-021
- **P-032** `todo` GATE — verify coord identity: a psu su session appears in `coord:presence` with a per-session `PAPERCUSP_SID` owner, and two concurrent psu sessions get distinct owners (no self-contention — the bug the per-session SID originally fixed). blocked-by: P-022

## Phase 4 — Retire the wrappers + shrink the installer

- **P-040** `todo` Delete the three `*-su` wrapper installs from `install-standalone-mcp.sh` (omp-su §4d, claude-su §4e, codex-su §4f) + the `codex-su` CODEX_HOME/hook setup now minted per-session; KEEP psu install, the superuser token, MCP registration (`~/.claude.json`/native codex config for plain agent use), the source playbooks, the coord extension, and the claude user-level lock hooks. blocked-by: P-031, P-032
- **P-041** `todo` Remove `SU_WRAPPER_BIN` + the wrapper-exec from `bootstrap-su`/psu; `bootstrap-su` returns the launch spec (not `wrapperBin`); `launch-su` (web) already routes through psu so it inherits the change. blocked-by: P-040
- **P-042** `todo` Rework `psu --resume` (`resumeArgsFor`) to launch raw CLIs with the resume flag + the same per-session config (was `claude-su --continue` / `omp-su -r` / `codex-su resume`). blocked-by: P-040

## Phase 5 — Cleanup, tests, docs

- **P-050** `todo` Delete now-dead wrapper helpers (`omp-su-wrapper.ts`, the codex-su-home installer bits, and `ensure-omp-su` IF only the wrapper used it — keep boot-used pieces); knip-check. blocked-by: P-040
- **P-051** `todo` Unit tests: `buildLaunchSpec` su variant (playbook prompt + superuser MCP); psu su-flow launch args per agent; resume args; update/retire wrapper-specific tests. blocked-by: P-020
- **P-052** `todo` Docs + memory: rewrite `agent-spawning/terminal-wrappers.mdx` (psu is the only launcher; su is the operator role at superuser tier; per-launch playbook + profile); update install docs; memory note that the `*-su` wrappers are retired and there's one `psu`/`buildLaunchSpec` path. blocked-by: P-040

## Decisions

### D-001 — `su` is the operator/engineer role at superuser tier (locked 2026-05-31)
`su` is not a separate launch mechanism: it is `buildLaunchSpec` with prompt =
the engineer playbook and scope = superuser. One spec, parameterized by `kind`.
(Earlier framing called these "two different things"; on inspection they're the
same operation with two different arguments — the real blocker was only the
standalone wrapper, which this plan removes.)

### D-002 — Keep `?superuser=1` (+ bearer) for `su`, not a signed `role=operator` URL (locked 2026-05-31)
`su` is deliberately full-catalog superuser (bypasses the role allowlist + quota
and requires loopback + bearer). A signed `role=operator` URL would gate it to
the operator role's *allowlist*, which is not the same as the superuser bypass,
and the bearer is already managed by the install. Roles keep their signed scoped
URLs. Revisit only if we decide `su` itself should be allowlist-gated.

### D-003 — Verify-hooks-before-delete gate (locked 2026-05-31)
The lock-enforcement hooks are load-bearing for multi-agent coordination. claude's
are user-level (survive a raw launch); **codex's live inside the scoped `codex-su`
CODEX_HOME and do NOT survive** unless the per-session CODEX_HOME re-homes them
(P-030). No `*-su` wrapper is deleted until P-031 (lock enforcement on all three
via psu) and P-032 (per-session coord identity) are green.

### D-004 — `--strict-mcp-config` for su: decide in P-020 (open)
Role sessions use `--strict-mcp-config` (claude) to pin to ONLY the role-scoped
server. For `su` we likely want the ambient superuser catalog; P-020 decides
whether su drops `--strict-mcp-config` and whether that changes the tool surface
vs today's `~/.claude.json` registration.

### Out of scope (boundary, not a decision)
The standalone superuser **shell** console (`console-launch mode:'shell'` →
`buildConsoleEnvelope`) is a separate feature (a bash shell with a superuser
`.mcp.json`, not an agent launch) — left untouched. This plan only retires the
three agent wrappers.

### D-005 — D-004 RESOLVED: su omits --strict-mcp-config (keeps the engineer's full MCP toolkit)
Date: 2026-05-31
Resolved while implementing suLaunchArgs (P-020). A pipeline ROLE is tool-scoped: claude gets `--mcp-config <role.json> --strict-mcp-config` so ONLY the role-scoped papercusp server loads (true allowlist enforcement). The engineer/collaborator `su` session is the opposite — a superuser who keeps their full MCP toolkit. So su passes `--mcp-config <superuser.json>` but NOT `--strict-mcp-config`: the per-launch superuser papercusp server is ADDED to whatever the user/project config already provides, rather than replacing it.

This preserves the prior `claude-su` wrapper behavior (it carried no --mcp-config at all and relied on the user-level `~/.claude.json` papercusp-su entry — i.e. all user servers were live), while removing the dependency on a pre-installed user-level entry (the per-launch .mcp.json from buildLaunchSpec now supplies the superuser server directly).

Codified in `suLaunchArgs` in psu-launcher.mjs + a test asserting the args do NOT contain --strict-mcp-config. Revisit only if a superuser session must be hard-isolated to the papercusp server (it currently should not be).
Related: P-020
