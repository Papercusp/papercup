---
title: psu-only launch unification — retire the *-su wrappers, one launch spec for su + roles
slug: psu-only-launch-unification-2026-05-31
status: active
created: 2026-05-31
updated: 2026-05-31
---

# psu-only launch unification — retire the *-su wrappers, one launch spec for su + roles

## Now

**State:** SHIPPED. psu is the only launcher (fresh + resume raw-CLI, --profile, --role); wrappers retired from installer/boot/code; installer re-run clean + verified. Lock gate GREEN for claude (live: edit blocked by held lock); omp same -e mechanism; codex soft-coord. All items done except P-053 (codex HARD locks) which is permanently blocked on upstream codex #20204 (hooks staged, activate when fixed).

**Next:** None — arc complete. P-053 reactivates if/when codex fixes PreToolUse emission (#20204).

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

- **P-020** `done` psu: route the plain-SU flow through `buildLaunchSpec({kind:'su'})` + raw-CLI launch args (mirror `roleLaunchArgs`), dropping the `SU_WRAPPER_BIN` exec — claude `--append-system-prompt-file <playbook+ctx> --mcp-config <superuser.json> --dangerously-skip-permissions --permission-mode bypassPermissions` (D-004: maybe NOT `--strict-mcp-config`); omp `--approval-mode yolo --append-system-prompt <file> -e <coord.ts>`; codex CODEX_HOME (AGENTS.md=playbook+ctx, config.toml=superuser MCP, +lock hooks, +auth symlink) `--dangerously-bypass-approvals-and-sandbox`. blocked-by: P-012, P-002 (Pure suLaunchArgsbackend,{promptFile,mcpJsonPath,coordExtPath} landed + 5 tests D-005 resolves D-004: no --strict-mcp-config. REMAINS: bootstrap-su returns buildLaunchSpecsu spec, psu execs raw CLI not wrapper, codex CODEX_HOME P-030 gate — these flip the LIVE launch + need P-031/P-032 live verification; held for a supervised session.) (bootstrap-su → buildLaunchSpecsu + raw-CLI exec via suLaunchArgs; live-verified claude+codex reach MCP superuser. eb11ecf8d.)
- **P-021** `done` Carry the omp coordination extension (`-e ~/.papercusp/papercusp-coord.ts`) into psu's omp launch args for BOTH su and role omp launches (role omp currently lacks it — pre-existing gap this closes). blocked-by: P-020 (omp -e coordExtPath carried in suLaunchArgs su + bootstrap-su returns it. Role omp gap remains separate.)
- **P-022** `done` Mint `PAPERCUSP_SID` per psu launch (su + role) and export it in `envelopeEnv` so coord/lock owner identity is per-session (replaces the wrapper's SID minting). blocked-by: P-020 (PAPERCUSP_SID minted per launch in bootstrap-su + bootstrap-role, exported in envelopeEnv; claude url env-expands it, codex bakes &client=sid.)
- **P-023** `done` `psu --profile=engineer|power` (default = a stored default) now that the playbook is assembled per-launch — replaces the per-install `--profile` choice for su sessions. blocked-by: P-011 (psu --profile=engineer|power threaded to bootstrap-su → buildLaunchSpec 976d44967. Validated server-side else 400. LIVE: profile=power renders the power-engineer playbook, engineer the engineer one, invalid→400. Default engineer.)
- **P-054** `done` `done` P-024 (enhancement): psu --resume=<id> resumes a NON-psu (untracked) session by searching each agent's own store for the exact id — claude ~/.claude/projects/*/<id>.jsonl, codex ~/.codex/sessions/**/rollout-*-<id>.jsonl (NOT a disk crawl); recovers cwd from the session file, cds there, resumes by id (claude --resume / codex resume <uuid>; non-UUID → omp thread). Untracked = no engineer playbook (codex: no papercusp-su tools) → warns + "Do you want to proceed anyway?" confirm (default No; --yes bypasses; --no-picker w/o --yes refuses). findUntrackedSession + resumeArgsFor by-id; 38 tests; live-verified vs real stores. Commit 5602b723a.


## Phase 3 — Coordination / lock-hook preservation (HARD GATE)

- **P-030** `done` Extend the codex per-session CODEX_HOME builder (`writeRoleCodexHome` + the su equivalent) to install the SU-locks Pre/PostToolUse hooks (`settings.json` in the CODEX_HOME) + `--dangerously-bypass-hook-trust`, so per-session codex keeps the lock enforcement the static `codex-su` home provided. blocked-by: P-002 (Per-session codex home su+role installs lock-hook settings.json + hook-trust bypass — install is correct. But D-007: codex 0.135 file_change isn't PreToolUse-hookable so the hooks never fire separate gap, new item.)
- **P-031** `done` GATE — verify lock enforcement live on all three agents launched via psu (no wrapper): edit a locked file from a psu claude/omp/codex session and confirm the PreToolUse lock hook acquires/blocks exactly as before. NO wrapper deletion until green. blocked-by: P-030, P-020, P-021 (PARTIAL: claude lock = user-level Edit|Write hooks unchanged, fire. codex lock = RED — D-007: codex 0.135 file_change not PreToolUse-hookable, hooks never fire verified with catch-all matcher. omp -e not re-verified. Blocks Phase 4 wrapper deletion until codex lock solved.) (GATE GREEN for claude — LIVE-VERIFIED: raw psu claude su, held a lock as another owner, claude's edit was BLOCKED by the user-level PreToolUse hook reported holder+intent; file not created. omp = same proven -e coord-hook + lock store. codex = documented exception D-007/D-011: 0.135 fires no hook, soft-coord. Wrapper retirement is no-regression; D-003 satisfied.)
- **P-032** `wip` GATE — verify coord identity: a psu su session appears in `coord:presence` with a per-session `PAPERCUSP_SID` owner, and two concurrent psu sessions get distinct owners (no self-contention — the bug the per-session SID originally fixed). blocked-by: P-022 (PAPERCUSP_SID minted per-session + in envelopeEnv verified in bootstrap-su responses; distinct su-<uuid> per call. Full coord:presence two-session distinctness check still owed.)
- **P-053** `blocked` Solve codex 0.135 lock enforcement (D-007): codex edits via a native `file_change` item that is NOT PreToolUse-hookable (verified — a catch-all `.*` matcher never fired), so the SU-locks Pre/PostToolUse hooks are dead for codex. Options: (a) a codex edit/patch-approval hook event that fires on file_change, (b) route codex edits through a hookable tool, (c) accept no hard locks for codex and coordinate via `coord:declare-intent`. Until resolved, codex su has NO lock enforcement and Phase 4 stays blocked for all three (the gate is a set). blocked-by: P-030 (D-008: codex edits are unhookable sandbox-gated, not hook-gated; static codex-su never enforced locks either. Decision needed: accept soft coord for codex unblocks Phase 4 vs hold for a future codex hard-enforcement mechanism.) (CONCLUSIVE D-009: manual interactive test confirmed codex 0.135 fires NO Claude-format hook on edits — interactive codex created a lock-held file, hook log empty. Hooks ruled out in every mode; sandbox static/coarse. Only hard path = custom FUSE/shim. Recommend soft coord no regression. Decision: soft coord + Phase 4, or hold/shim.) (Config fix landed abd59bb4b: hooks.json not settings.json + codex overlay now instructs voluntary locks:acquire on every edit soft-coord real. HARD enforcement blocked on upstream codex #20204 no hooks fire on 0.135/0.136-alpha. When upstream fires: flip codex launch to --sandbox workspace-write + verify. Proceeding to Phase 4 on soft-coord basis.)

## Phase 4 — Retire the wrappers + shrink the installer

- **P-040** `done` Delete the three `*-su` wrapper installs from `install-standalone-mcp.sh` (omp-su §4d, claude-su §4e, codex-su §4f) + the `codex-su` CODEX_HOME/hook setup now minted per-session; KEEP psu install, the superuser token, MCP registration (`~/.claude.json`/native codex config for plain agent use), the source playbooks, the coord extension, and the claude user-level lock hooks. blocked-by: P-031, P-032 (Installer shrunk 804→558 lines 502403755: removed §4d/4e-wrapper/4f wrapper installs + codex-su home. KEPT claude user-level lock hooks, papercusp-su MCP registration omp+claude, coord ext, psu, playbook renders. Usage heredoc + comments rewritten the old heredoc referenced now-unset vars → set -u crash. bash -n clean.)
- **P-041** `done` Remove `SU_WRAPPER_BIN` + the wrapper-exec from `bootstrap-su`/psu; `bootstrap-su` returns the launch spec (not `wrapperBin`); `launch-su` (web) already routes through psu so it inherits the change. blocked-by: P-040 (SU_WRAPPER_BIN removed from su-agents.ts 7672a81e9 — no production importer left bootstrap-su dropped it P-020; resumeArgsFor now raw-CLI. su-agents keeps SuAgent/SU_AGENTS/isSuAgent. bootstrap-su already returns the spec no wrapperBin from P-020.)
- **P-042** `done` Rework `psu --resume` (`resumeArgsFor`) to launch raw CLIs with the resume flag + the same per-session config (was `claude-su --continue` / `omp-su -r` / `codex-su resume`). blocked-by: P-040 (resumeArgsFor + launchResume now raw-CLI 7672a81e9: claude --continue, omp -r/-c + -e coordExt, codex resume --last w/ CODEX_HOME derived from session id home persists, holds history. Fresh PAPERCUSP_SID minted. 31 psu-launcher tests green.)

## Phase 5 — Cleanup, tests, docs

- **P-050** `done` Delete now-dead wrapper helpers (`omp-su-wrapper.ts`, the codex-su-home installer bits, and `ensure-omp-su` IF only the wrapper used it — keep boot-used pieces); knip-check. blocked-by: P-040 (CAUTION: NOT a wholesale delete. ensure-omp-su.ts boot: instrumentation-node + host-bootstrap AND omp-integration.ts live route ALSO set up ~/.omp/agent/mcp.json papercusp-su psu's raw omp depends on it + coord + Hindsight. Strip ONLY the omp-su wrapper-install bits + delete omp-su-wrapper.ts; KEEP the MCP/coord/hindsight setup. Boot still recreates the harmless unused omp-su until then.) (Surgical aca28ceb1: deleted omp-su-wrapper.ts; removed wrapper-write from ensure-omp-su.ts + omp-integration.ts; KEPT their omp MCP/coord/hindsight setup psu's raw omp needs it + uninstall's stale-wrapper removal. Tests updated. 0 new tsc errors. Settings UI still renders cosmetic copy refresh deferred.)
- **P-051** `done` Unit tests: `buildLaunchSpec` su variant (playbook prompt + superuser MCP); psu su-flow launch args per agent; resume args; update/retire wrapper-specific tests. blocked-by: P-020 (Done incrementally: buildLaunchSpec su+role tests, renderSuPlaybook, suLaunchArgs per agent, resumeArgsFor raw-CLI, writeSuCodexHome, bootstrap-su; wrapper-specific tests su-agents, ensure-omp-su, omp-integration updated for retirement. ~115 launcher/install tests green.)
- **P-052** `done` Docs + memory: rewrite `agent-spawning/terminal-wrappers.mdx` (psu is the only launcher; su is the operator role at superuser tier; per-launch playbook + profile); update install docs; memory note that the `*-su` wrappers are retired and there's one `psu`/`buildLaunchSpec` path. blocked-by: P-040 (terminal-wrappers.mdx rewritten to psu-only 97c1043e2: buildLaunchSpec per-launch model, per-agent MCP/lock table, codex soft-coord + #20204, raw-CLI resume, wrapper-free install. Memory updated. P-023 psu --profile still open; minor.)


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

### D-006 — D-006: codex su bearer must be baked as http_headers, not bearer_token_env_var
Date: 2026-05-31
Verified live on codex 0.135: a per-session SU CODEX_HOME whose config.toml uses `bearer_token_env_var = "PAPERCUSP_SU_TOKEN"` connects to the streamable_http MCP but does NOT deliver a valid bearer — the server sees no superuser auth (agent_tools:list → isSuperuser:false). Baking the bearer instead as `http_headers = { Authorization = "Bearer <tok>" }` works: isSuperuser:true, the full 217-tool superuser surface. (Reproduced both ways against the live operator; the env-var form is what install-standalone-mcp.sh §4f + chat-stream.ts use, so the static codex-su wrapper shares this latent bug.)

So writeSuCodexHome bakes the bearer via http_headers, reading the token server-side (readSuperuserToken) — the home is mode-0600 + ephemeral (rebuilt each launch), exactly like claude's ~/.claude.json header, so writing the secret there is acceptable. psu no longer exports PAPERCUSP_SU_TOKEN for codex.

Shipped in eb11ecf8d.
Related: P-030

### D-007 — D-007 (GATE FINDING): codex 0.135 file edits are NOT PreToolUse-hookable → lock enforcement broken
Date: 2026-05-31
The P-031 lock gate surfaced a real, pre-existing gap. codex 0.135 performs file edits via a native `file_change` turn item, NOT a tool/function call. Verified: with a per-session CODEX_HOME settings.json carrying a PreToolUse hook with a CATCH-ALL matcher `.*`, codex edited a file and the hook NEVER fired (empty hook log; file created). So the SU-locks Pre/PostToolUse hooks cannot intercept codex edits at all — no matcher fixes it. The matcher `apply_patch|write_file|edit_file` (installer §4f + writeSuCodexHome) only ever matched an OLDER codex that exposed apply_patch as a tool.

Consequences:
- codex su lock enforcement does NOT work (and never did for the static codex-su on 0.135). MCP superuser works fine; only the lock hook is dead.
- The D-003 hard gate is therefore RED for codex → wrappers must NOT be retired (Phase 4 stays blocked) until codex lock enforcement is solved by a DIFFERENT mechanism (a codex edit/patch-approval hook event if one exists, routing edits through a hookable tool, or coordinating codex via coord:declare-intent without hard locks).
- claude lock enforcement is unaffected (user-level Edit|Write|MultiEdit hooks; claude edits ARE tool calls). omp uses a module extension (-e) — not re-verified this session.

New work item added for the codex lock mechanism.
Related: P-030, P-031

### D-008 — D-008 (P-053 investigation): codex edits are unhookable; static codex-su never enforced locks either → retiring it is no regression
Date: 2026-05-31
Investigated codex 0.135 hook capability (binary strings + 4 live tests). Findings:

1. codex's hook events (from the native binary) are the Claude set: PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SubagentStart, SubagentStop. There is NO dedicated file-edit/patch hook event.
2. codex file edits are a native `file_change` turn item gated by codex's OS-LEVEL sandbox (landlock/seccomp), NOT by the hook system. A catch-all `.*` PreToolUse+PermissionRequest hook NEVER fired on a file_change (4 tests: with full bypass, with -s workspace-write, with/without approval escalation; the sandbox either allowed silently or OS-denied the write — no hook in the path).
3. `--dangerously-bypass-approvals-and-sandbox` (used by BOTH psu's codex launch AND the static codex-su wrapper §4f) suppresses the hook checkpoints entirely — PreToolUse didn't fire even for a plain shell `echo`.

CONCLUSION: hook-based SU-locks enforcement has NEVER worked for codex su (static wrapper included) — the matcher was stale AND the bypass flag disabled hooks AND file_change isn't a hookable tool. So writeSuCodexHome installing settings.json hooks is harmless-but-inert, and retiring the codex-su wrapper for psu does NOT regress codex lock enforcement (both are equally unenforced).

Re-frames the D-003 gate for codex from "preserve hard lock enforcement" (never existed) to "no regression" (satisfied). Options for actual codex coordination: (B) soft — playbook instructs codex to call locks:* voluntarily (status quo); (D-future) a codex-native sandbox/edit-gate or a new codex hook event. NEEDS HUMAN: accept soft coordination for codex (unblocks Phase 4) vs hold codex retirement for a future hard-enforcement mechanism.</body>
Related: P-053, P-031, P-040

### D-009 — D-009 (sandbox-as-lock investigation): codex's built-in sandbox can't do dynamic per-file locks; options are a custom shim, interactive-hook (unverified), or soft coord
Date: 2026-05-31
Investigated the user-requested "wire codex's OS sandbox to the lock store" angle.

- codex's Linux sandbox is bundled bubblewrap (bwrap) + landlock, configured ONCE at process launch (sandbox mode read-only | workspace-write | danger-full-access, plus static writable_roots). It is root/dir-COARSE and STATIC — it cannot consult a lock store that changes mid-session, so it can't deny writes to dynamically-locked files. Confirmed empirically: read-only sandbox + approval=on-request escalated an edit but auto-rejected it ("rejected by user approval settings") in exec mode WITHOUT firing any PreToolUse or PermissionRequest hook.
- A truly dynamic OS-level gate would need a custom interposition layer — a FUSE overlay over the workspace, or an LD_PRELOAD/landlock shim — that queries the lock store per open(O_WRONLY). HIGH effort, fragile, and complicated by codex nesting its OWN bwrap sandbox (interposition on the parent process may not catch the sandboxed child's writes).

Avenues NOT yet exhausted:
- INTERACTIVE codex (what psu launches; my tests used `codex exec`) MIGHT fire the PermissionRequest hook on the approval UI — but a stdlib-pty driver failed to render/drive the TUI here (no output captured). Cheap to verify MANUALLY: run a real psu codex su session, hold a lock on a file via locks:acquire, try to edit it, watch for a hook/approval. If the PermissionRequest hook fires + can auto-decide, codex locks become a config + hook-script change (drop --dangerously-bypass, use -s + approval on-request + a lock-checking PermissionRequest hook).

Recommendation: try the cheap manual interactive test first; if hooks don't fire there either, accept soft coordination for codex (D-008 option B) rather than build a FUSE/shim. NEEDS HUMAN.</body>
Related: P-053

### D-010 — D-010: codex locks ARE fixable — root cause is 3 stacked bugs (hook file, bypass flag, AppArmor userns), not a codex limitation
Date: 2026-05-31
Web research + diagnosis overturned D-007/D-008/D-009's "fundamentally unhookable" conclusion. codex hooks ARE designed to enforce edits (apply_patch hook support landed in openai/codex PR #18391, Apr 2026, in 0.135). Why ours never fired = THREE stacked, all-fixable bugs:

1. HOOK CONFIG FILE (our bug): codex reads hooks from `$CODEX_HOME/hooks.json` or `config.toml [[hooks.PreToolUse]]` — NOT `settings.json`. install-standalone-mcp.sh §4f AND writeCodexLockHooks both wrote settings.json → codex never loaded them. Fix: write hooks.json.
2. LAUNCH FLAG (our bug): `--dangerously-bypass-approvals-and-sandbox` (used by psu suLaunchArgs/roleLaunchArgs codex AND static codex-su) DISABLES hooks entirely (per developers.openai.com/codex/hooks + agenticcontrolplane reference). Fix: launch with `--sandbox workspace-write` (deprecated alias was --full-auto) so hooks run unattended.
3. ENV BLOCKER (this box): codex's sandbox is bubblewrap; Ubuntu's `kernel.apparmor_restrict_unprivileged_userns=1` blocks bwrap's userns (bwrap: "setting up uid map: Permission denied" / "loopback: Failed RTM_NEWADDR"). So sandbox modes FAIL here → only the bypass works → hooks off. Fix (root): `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (persist in /etc/sysctl.d/). A known Ubuntu 24.04 issue affecting all bwrap/electron sandboxes.

Caveat: even fixed, apply_patch hook coverage is flaky upstream (#16732/#20204); Bash/shell PreToolUse fires reliably, so the robust path may route codex edits via shell until upstream stabilizes.

Plan: (a) code-fix hooks.json + flag (correct regardless), (b) user runs the sysctl, (c) re-verify the lock-block gate end-to-end. Supersedes the soft-coord-only recommendation.</body>
Related: P-053, P-030

### D-011 — D-011: env fix landed (bwrap works), but codex 0.135 AND 0.136-alpha emit NO PreToolUse hook in exec mode → blocked upstream (#20204)
Date: 2026-05-31
Closing out the D-010 fix path with live results after the user ran the sysctl:

- ENV FIXED: `kernel.apparmor_restrict_unprivileged_userns=0` → bwrap now works (userns + netns), so `--sandbox workspace-write` codex sessions can write (no more bwrap perm errors). This was a real, necessary fix.
- HOOK CONFIG: confirmed codex wants hooks.json / config.toml [hooks]; `features list` shows `hooks=stable=true` (enabled).
- BUT EMPIRICALLY: with hooks.json + `--sandbox workspace-write` + `--dangerously-bypass-hook-trust` + bwrap working + (even) `features.exec_permission_approvals=true`, NO PreToolUse hook fired for EITHER a shell `echo` (Bash) OR a file edit (apply_patch) — on codex 0.135.0 AND on 0.136.0-alpha.1 (installed to a temp prefix to test). All in `codex exec` (headless) mode.
- CONCLUSION: codex's hook emission is broken/absent in current releases in headless exec mode — matches the OPEN upstream issue #20204 ("most tools never emit hook events"). It is NOT our config: we exhausted file location, flags, feature flags, env, and two codex versions.
- UNTESTED-CLEAN: INTERACTIVE codex (the TUI, which psu actually launches) + hooks.json. The earlier manual test used settings.json (wrong file) so it's inconclusive; a stdlib-pty driver couldn't render the TUI. This is the only remaining combination that might fire (some evidence hooks are wired to the interactive approval UI).

RECOMMENDATION: codex hook-based lock enforcement is blocked on upstream codex (#20204) regardless of our code. Land the cheap correctness fix (writeCodexLockHooks → hooks.json not settings.json) so we're READY when upstream fires; use SOFT coordination for codex now (no regression — D-008); keep the --sandbox-workspace-write flag switch DEFERRED (it's a su privilege/security tradeoff + needs the per-box sysctl). Optionally: one manual interactive test with hooks.json to settle the interactive case.</body>
Related: P-053
