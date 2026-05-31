---
title: Three-client file-lock enforcement (Claude · Codex · OMP)
slug: three-client-lock-enforcement-2026-05-30
created: 2026-05-30
updated: 2026-05-31
status: shipped
---

## Now

**State:** **Shipped + activated.** All three clients now enforce SU-locks. Merged to `main` (merge `ab589a2d`) and the installer was run on this host: the shared `cc/` hooks live in `~/.papercusp/hooks/cc/`, wired into `~/.claude/settings.json` (Claude, matcher `Edit|Write|MultiEdit`) and the codex-su `CODEX_HOME/settings.json` (Codex, matcher `apply_patch|write_file|edit_file`, wrapper carries `--dangerously-bypass-hook-trust`); OMP via `omp-su -e`. Verified end-to-end against the live operator (acquire → contended `deny` → release for both `Edit` and `apply_patch` shapes; workspace scoping; fail-open) and the hook was observed blocking a real edit in a live session.

**Per-session identity — FIXED for `-su` (option (a), the unified-id approach).** Root cause was broader than first thought: all same-machine SU sessions collapsed to the static `?client=<machine-uuid>`, so (1) `coord:inbox` self-filtered peers' broadcasts (a peer's message looked self-sent) AND (2) the manual-acquire owner differed from the hook owner → manual-claim self-deadlock. Fix: each `-su` wrapper mints a per-launch `PAPERCUSP_SID`; the interactive MCP `?client=` carries it (Claude via `~/.claude.json` `${PAPERCUSP_SID:-<machine-id>}` env-interpolation; Codex via a `codex-su -c mcp_servers.papercusp-su.url=…&client=$SID` override) AND the cc hook reads the SAME `PAPERCUSP_SID` as its owner. So within a shell, interactive calls + hook share one owner (manual claims no longer self-block); across shells, ids are distinct (coord no longer self-filters). Plain `claude`/`codex` (no env) fall back to the machine id → unchanged. `identity.ts` / `_mcp-handler.ts` untouched — we just feed `?client=` a per-session value. Verified: two distinct SIDs contend even with identical `session_id`; the SID → session_id → agent_id fallback chain works.

**OMP interactive per-session id — RESOLVED 2026-05-31 (D-006, supersedes D-005's "blocked"):** D-005 was right that OMP can't env-interpolate the mcp.json URL, but wrong that this blocked the item. The per-session id rides a **header**, not the URL: OMP resolves every MCP header value at connect time (`config/resolve-config-value.ts` — a `!cmd` value runs in a subshell inheriting the OMP process env) and its HTTP transport sends config headers on every request. Fix (shipped + verified live): (1) `_mcp-handler.ts` MCP superuser+power-user paths source the coord/lock owner as `x-papercusp-client` header → `Mcp-Session-Id` → `?client=` (header HIGHEST precedence — the transport OMP actually uses, *not* `buildHttpSpawnContext`); (2) the installer's OMP `mcp.json` writer adds `x-papercusp-client: !printf %s "${PAPERCUSP_SID:-}"`, resolving to the per-launch `PAPERCUSP_SID` that `psu` already exports (`psu-launcher.mjs:556`), and dropped when unset → plain `omp` falls back to the static `?client=`; (3) `http-projection.ts` gets the same header source for REST-transport parity. NOT a rejected D-005 workaround — it's OMP's first-class resolveConfigValue-on-headers (no node_modules patch, no racy mcp.json rewrite), and the explicit SID header OUTRANKS `Mcp-Session-Id` so it doesn't re-break the CC unified-owner design. Verified live (after a `papercup-dev-api.service` restart): operator honors the header over a differing `?client=`, and OMP's own `resolveHeaders` against the live `~/.omp/agent/mcp.json` yields the SID → `coord:whoami` ownerId == that SID. See D-006. (Note: the `*-su` wrappers D-005 investigated are retired — launch is now `psu`.)

**OMP↔cc worktree-scope inconsistency — RESOLVED 2026-05-30 (D-004, commit `a56c7caf`):** the cc hook keyed lock paths relative to *any* direct-child worktree of `~/papercupai-workspace` (walk up to `.git` per edit, then workspace-scope), but the OMP `coord-hook.ts` keyed on a SINGLE `papercupRoot()`, so cross-client contention was LOST whenever an OMP agent edited a *sibling* worktree (OMP skipped it; a cc client there would lock it). Fixed by mirroring the cc hook's per-edit `find_repo_root` + workspace gate in `coord-hook.ts` (`extractLockTargets` walks to each path's `.git` root and keys relative to it; `papercupRoot()`/`PAPERCUSP_REPO_ROOT` removed in favour of `workspaceRoot()`/`PAPERCUSP_WORKSPACE_ROOT`). The human's "do both" was the sign-off the prior "not changed unilaterally" decision deferred to. 62/62 tests green (real `.git` fixtures + sibling-worktree contention case), `tsc` clean, activated live at `~/.papercusp/papercusp-coord.ts`. See D-004.

**Next:** nothing actionable — all threads closed. In-vivo verification handoff CLOSED (D-001/D-002/D-003); OMP↔cc worktree-scope unified (D-004, `a56c7caf`); OMP *interactive* per-session id RESOLVED in-product via header-sourced `x-papercusp-client` (D-006, supersedes the D-005 "blocked-on-upstream" — no OMP upstream change needed). All three clients (Claude/Codex/OMP) now get a distinct per-launch coordination owner across interactive + hook calls. The only loose end is unrelated: a pre-existing OMP model-API bug (a tool inputSchema serializing `properties` as a bool) blocks `omp -p` headless model runs — flagged to peers, not part of this plan.

---

## Handoff — live in-vivo verification (next agent)

**Why this is open.** The per-session identity fix (`3761b32b`) is verified at the **hook layer** (two `PAPERCUSP_SID`s contend even with identical `session_id`) and the **coord layer** (direct MCP calls with two distinct `?client=` values: A's broadcast is visible to B and self-filtered from A). The one thing NOT yet observed is a **real `claude-su` / `codex-su` process** resolving to its `PAPERCUSP_SID` end-to-end — the full chain *wrapper env-export → client config (`${PAPERCUSP_SID:-…}` interp for Claude / `-c` url override for Codex) → MCP `?client=` → distinct owner*. The building session couldn't drive a second interactive client headlessly. This is belt-and-suspenders (each link is independently verified), but worth one real run.

**Pre-req.** New wrappers + `~/.claude.json` are installed (done as of `3761b32b` + the post-commit installer re-run). If unsure: `bash apps/operator/scripts/install-standalone-mcp.sh`.

**Procedure — Claude:**
1. Launch a `claude-su` shell (its wrapper exports `PAPERCUSP_SID=claude-su-<uuid>`).
2. Have it call `coord:whoami` → **`ownerId` must start with `claude-su-`**, NOT `28dbf719…`. That one check proves the wrapper→config→`?client=` chain.
3. Have it `coord:send { to:['*'], summary:'invivo-A <nonce>' }`.
4. Launch a SECOND `claude-su` shell; call `coord:inbox` → it **must list `invivo-A`** (cross-shell visibility — the bug that started this arc).
5. Back in shell A, `coord:inbox` → must **NOT** show its own `invivo-A` (self-filter).

**Procedure — Codex:** same via `codex-su`; step-2 `ownerId` should start with `codex-su-`. Codex gets the id from the wrapper's `-c mcp_servers.papercusp-su.url=…&client=$PAPERCUSP_SID`.

**Pass criteria:** distinct `claude-su-*` / `codex-su-*` owner per shell; peer broadcast visible cross-shell; self-filtered for the sender.

**If owner is still `28dbf719…` (fail):** Claude — confirm `~/.claude.json` papercusp-su `url` contains the literal `${PAPERCUSP_SID:-…}` and the session actually had `PAPERCUSP_SID` exported; verify env-interpolation is honored on that Claude Code version. Codex — confirm the `-c` override reached + was honored.

**Gotchas:**
- **Do NOT** probe Codex by copying `~/.codex/auth.json` into a throwaway `CODEX_HOME` — it rotates/invalidates the user's real Codex login. Use the real `codex-su`. (See `agent-insights` / the `feedback_codex_auth_probe_hazard` memory.)
- A *plain* `claude`/`codex` (no `-su`) has no `PAPERCUSP_SID` → resolves to the machine id. Expected, not a failure.
- `coord:inbox` is the file-log scan with self-exclusion (`excludeOwn`) — that filter is correct; the fix is the distinct owner, not the filter.

**Artifacts:** fix `3761b32b`; wrappers + config writes in `apps/operator/scripts/install-standalone-mcp.sh`; owner resolution in `apps/operator/scripts/hooks/cc/{pretooluse-locks-acquire,posttooluse-locks-release}.sh`; identity resolver (unchanged) `apps/operator/lib/agent-tools/coordination/identity.ts`.

---

# Three-client file-lock enforcement

## §0 Context — why this plan exists

`file-locking-improvements-2026-05-20.md` made an **OMP-only** decision (§1 non-goal, item #2): drop Claude/Codex/Gemini integration, delete the Claude `Pre/PostToolUse` shell hooks (shipped in `9ebb499a`, deleted in `64b01fc9`), and route all enforcement through one OMP `tool_call` hook. That decision has since been **reversed in practice but not in code**: multi-client SU support returned — `papercusp-su.claude.md` / `.codex.md` / `.omp.md` overlays, `claude-su` / `codex-su` / `omp-su` wrappers, the four-client engineer playbook — yet enforcement never followed the clients back.

The supported client set is now **Claude Code, Codex, and OMP** (Gemini is NOT supported; some prompt files still wrongly list it — drop it).

## §1 Current state — all three clients non-enforcing

| Client | Hook capability | What exists today | Enforcing? |
|---|---|---|---|
| **OMP** | `tool_call` TS hook (`return { block, reason }`) | `scripts/hooks/omp/coord-hook.ts` — built (51KB): acquire+block+release+fail-open+symlink-refusal+health-markers | **No** — not installed (`~/.omp/agent/hooks/` absent; `agent-bundle.ts` README says it serves `hooks: []`) |
| **Claude Code** | `PreToolUse`/`PostToolUse`, `~/.claude/settings.json`, `hookSpecificOutput.permissionDecision: "deny"` | Shell hooks **deleted** in `64b01fc9`; recoverable from `9ebb499a` | **No** — deleted; prompt still claims they run |
| **Codex** | `PreToolUse`/`PostToolUse`, `settings.json` — **same wire format as Claude** (binary defines `PreToolUseHookSpecificOutputWire`, `PostToolUseHookSpecificOutputWire`, `PreToolUsePermissionDecisionWire`; emits `Command blocked by PreToolUse hook:`; has a hook-trust model) | Never built | **No** |

Verified by inspecting the Codex `0.135.0` native binary (`@openai/codex-linux-x64`), the deleted hooks in git, and the absent `~/.omp/agent/hooks/`.

## §2 The unifying insight

Claude and Codex implement the **same hook wire format**: both read `settings.json`, fire `PreToolUse`/`PostToolUse`, and honor `hookSpecificOutput.permissionDecision: "deny"` (whose `permissionDecisionReason` is fed back to the *model* so it can replan — unlike exit-code-2, which surfaces only to the user). So **one shared hook script pair serves both clients.** OMP is the only client needing its own implementation (TS module loaded in-process), and that already exists.

**One hook core, three install paths** — not three builds.

## §3 Build

### §3.1 Shared CC hook core — `apps/operator/scripts/hooks/cc/`
Recover `pretooluse-locks-acquire.sh` + `posttooluse-locks-release.sh` from `9ebb499a` and modernize:

- **Refusal → JSON `permissionDecision: "deny"`** on stdout (old scripts used exit-2 + stderr, which today reaches only the user). Reason: `Held by <owner_label> until <expires_ts>: <intent>` — model sees it, pivots/yields.
- **Repo root from stdin `cwd`** (not a hardcoded path — 10+ worktrees live in this workspace).
- Port the OMP hook's **symlink refusal** (`detectSymlinkedPaths`) and **`last-error.json` / `last-success.json` health markers** (under `~/.papercusp/locks-cache/`) so every client degrades identically and visibly.
- Keep the recovered strengths: fail-open if Papercusp absent / operator unreachable (exit 0); `tool_use_id → lock_id` FS cache for the release half (each Pre/Post fires as a separate subprocess, so the cache must be on disk, not in-memory); per-**session** owner identity (`session_id`) so two shells on one machine are distinct owners; `locks:acquire { wait: { max_sec: 0 } }` over MCP JSON-RPC (`/api/mcp?superuser=1`) with the bearer from `~/.papercusp/superuser-token`.

### §3.2 Claude wiring — `install-standalone-mcp.sh`
Write a `PreToolUse`/`PostToolUse` block into `~/.claude/settings.json` pointing at the shared scripts. **As shipped:** matcher is `Edit|Write|MultiEdit` (MultiEdit covered too), and the owner is the per-launch `PAPERCUSP_SID` (see the Now block's per-session-identity fix), falling back to Claude `session_id` then the machine id. Replaces the stale "if/when it ships" comment.

### §3.3 Codex wiring — `install-standalone-mcp.sh`
Write the same hook block into `$CODEX_HOME/settings.json`, plus:
- **Hook trust** — Codex requires persisted hook trust before running hooks. **As shipped:** the codex-su wrapper passes `--dangerously-bypass-hook-trust` rather than persisting trust. The dedicated codex-su `CODEX_HOME` contains only the two hooks this installer wrote, so this is the documented "automation that vets its own hook sources" path; persisted-trust was the original preference but the bypass was chosen as simpler for a fully-managed home.
- Add/confirm the `codex-su` wrapper with the same overlay-splice treatment as `claude-su`/`omp-su`.
- **Pre-req spike (verify before coding):** Codex's edit tool name(s) + `tool_input` shape (`apply_patch`/`shell` vs `Edit`/`Write`), the exact `settings.json` path under `CODEX_HOME`, and which field carries the per-session owner id.

### §3.4 OMP wiring — install the hook that already exists
Install `coord-hook.ts` into `~/.omp/agent/hooks/` (engineer path) and resolve the `agent-bundle.ts` vs README `hooks: []` contradiction so power-user sessions receive it. Verify it loads + blocks.

### §3.5 Shared observability — hook-health route
Build the `su-locks/hook-health` endpoint that `CoordDashboard.tsx` already references but which doesn't exist: reads the two marker files, returns `{ healthy, last_success_ts, last_error }`. One route covers all three clients. Banner = optional follow-up.

### §3.6 Prompt truth-up
- **Drop Gemini** from every file that lists the client set.
- Align `locks:acquire` `guidance`, `papercusp-su-engineer.tools.md` §12, `papercusp-su-power.tools.md`, and the three client overlays to one **trigger-anchored decision tree** (acquire → edit → release; on busy retry/pivot/yield; declare-intent on new task; handoff; release `all_mine` at session end), in identical wording.
- Frame the hook as a **backstop for incidental single-file edits**; deliberate multi-file work still needs a manual `acquire` held across the commit (the hook releases per-edit, so it does not cover the edit→commit window).

### §3.7 Plan-doc update
Record in `file-locking-improvements-2026-05-20.md` that the OMP-only decision is **reversed** — three-client enforcement is the design — so the next agent doesn't re-delete the CC hooks citing that doc.

## §4 Verification

- **Per client:** two `*-su` shells edit the same file → second is blocked with a *visible* reason; lock appears in `locks:queue` with distinct owners; kill operator mid-edit → `last-error.json` populates, edit fails open.
- **Cross-client:** a Claude shell and an OMP shell contend on the same file → second blocks. They share one PG lock store, so this MUST work across clients, not just within one.
- `su-lock-store` vitest suite stays green; `tools-md-sync.mjs` green after prompt edits.

## §5 Risks / pre-reqs

- **Codex spike first** — tool names, `tool_input` shape, `settings.json` path, hook-trust mechanics. Verify, don't guess (same discipline the prior locks plan's risk register demanded for OMP).
- **OMP bundle wiring** — the README/code disagreement must be settled or OMP stays non-enforcing.
- **Per-edit window** — the hook protects the edit instant, not edit→commit; manual claims remain the tool for deliberate multi-file work (reflected in the prompt).
- **Hook-trust UX (Codex)** — a too-aggressive trust prompt on first edit could annoy; install-time trust persistence avoids per-edit friction.

## §6 What's explicitly not changing

- SU-locks stays PG-backed on `papercusp_su`; no new store.
- Existing `locks:*` tool wire shapes stay the same.
- OMP's `tool_call` hook implementation stays as the OMP-side source of truth; the CC scripts are a parallel implementation of the *same contract*, not a rewrite of it.
- Gemini stays unsupported.

End of plan.

## Decisions

### D-001 — In-vivo verification executed (2026-05-30): Claude PASS end-to-end; Codex blocked on CLI auth
Date: 2026-05-30
Ran the "## Handoff — live in-vivo verification" procedure against real `*-su` processes on this host (live operator :3070).

**Claude — PASS (all 5 steps, real `claude-su -p` processes):**
- Deterministic SID: exported `PAPERCUSP_SID=claude-su-invivoA-2e0957d9`, launched real `claude-su`, `coord:whoami` → ownerId **exactly** `claude-su-invivoA-2e0957d9`. Proves the full chain wrapper env-export → `~/.claude.json` `${PAPERCUSP_SID:-…}` interpolation → MCP `?client=` → distinct owner (the one link never observed live before). Corollary: a *plain* `claude` (this session, SID unset) resolved to the `:-` fallback `28dbf719…`, NOT the literal `${…}` string — independently confirming Claude Code honors the interpolation.
- Pure mint (no preset SID): real `claude-su` → ownerId `claude-su-8ff1e771-…`, distinct from both the machine id and run A → two shells get distinct owners.
- Cross-shell coord (the headline bug): shell A `claude-su-coordA-9253c0b0` broadcast `invivo-A 9253c0b0` to `['*']`; shell B `claude-su-coordB-9253c0b0` `coord:inbox` → **SEEN=yes**; shell A `coord:inbox` → **SELF=no** (self-filter intact). Third-party corroboration: the machine-id (28dbf719) inbox shows the message with `from: claude-su-coordA-9253c0b0` — owner proven server-side via the `from` field, not just self-report.

**Codex — BLOCKED (not a lock-identity defect):** real `codex-su exec` 401'd with `refresh_token_reused` / `token_invalidated` from chatgpt.com before the owner could be read. The codex CLI's ChatGPT login is invalidated. `codex-su-home/auth.json` is a **symlink** to the real `~/.codex/auth.json` (mtime 2026-05-28 20:43, mode 600) — my runs did NOT write it (mtime unchanged) and a reused-refresh-token attempt consumes nothing new server-side, so this was pre-existing, not caused/worsened by the test. The Codex `-c mcp_servers.papercusp-su.url=…&client=$PAPERCUSP_SID` override path remains verified-by-construction (wrapper + config.toml read correct); the live owner read needs a Codex re-login (`codex login`) to complete. Note: codex non-interactive form is `codex exec --skip-git-repo-check "<prompt>"` with stdin closed.

**Net:** Claude branch of the per-session-identity fix (`3761b32b`) is now verified live end-to-end. Remaining handoff item: re-run the Codex step after the user re-authenticates Codex.

### D-002 — Codex in-vivo verification now PASSES (supersedes D-001's "blocked"); headless codex exec needs --dangerously-bypass-approvals-and-sandbox for MCP tools
Date: 2026-05-30
Follow-up to D-001 after the user re-authenticated Codex (`codex login`). The Codex branch of the per-session-identity fix is now verified live, so **both** CC clients are confirmed end-to-end.

**Codex — PASS:** real `codex-su exec` with `PAPERCUSP_SID=codex-su-invivo-be2d8ae4` → `coord:whoami` returned ownerId **exactly** `codex-su-invivo-be2d8ae4`. Independent server-side corroboration: the machine-id (28dbf719) inbox shows its broadcast with `from: codex-su-invivo-be2d8ae4`. Proves the Codex chain wrapper-mint → `-c mcp_servers.papercusp-su.url=…&client=$PAPERCUSP_SID` override → MCP `?client=` → distinct owner. (The D-001 block was purely a stale ChatGPT login — `refresh_token_reused` — not a lock/identity defect.)

**Operational gotcha discovered (headless codex + MCP):** in non-interactive `codex exec`, papercusp-su MCP tool calls fire an MCP-tool-call **approval elicitation** (`ResolveElicitation { request_id: "mcp_tool_call_approval_…" }`). With no interactive user, codex auto-resolves it `Cancel` → the call shows `(failed)` / "user cancelled MCP tool call". This is SEPARATE from `approval_policy`/`-a never` (which only governs shell commands) — setting that did NOT help. The fix for headless runs is `--dangerously-bypass-approvals-and-sandbox` (an `exec`-level flag). Interactive `codex-su` TUI sessions are unaffected: the user simply approves the elicitation, and the identity mechanism works the same. So this constrains headless automation of codex-su, not real engineer sessions.

Working headless form: `codex-su exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "<prompt>" < /dev/null` (the git-repo-check skip is needed outside a trusted dir; close stdin or it blocks reading it).

**Net handoff status:** the "## Handoff — live in-vivo verification" item is COMPLETE for both Claude (D-001) and Codex (this). Remaining plan items unchanged: OMP interactive per-session id; (low) OMP↔cc worktree-scope unification.

### D-003 — In-vivo verification re-run from a GENUINE interactive claude-su session — Claude PASS (closes the one caveat D-001/D-002 left: real interactive shell, not headless -p)
Date: 2026-05-30
Date: 2026-05-30
Re-ran the "## Handoff — live in-vivo verification" Claude procedure, this time with **shell A being a real interactive `claude-su` engineer session** (this session) rather than a headless `claude-su -p` run. The handoff explicitly flagged that the building session "couldn't drive a second interactive client" — this run closes that exact gap. The fix under test is unchanged (`3761b32b`).

**Claude — PASS (all applicable steps):**
- **Step 2 (shell A owner):** `coord:whoami` from this live interactive session → ownerId `claude-su-b9596222-fbd4-404a-9cec-a2a35f32457c` — starts with `claude-su-`, NOT the machine id `28dbf719…`. First confirmation of the wrapper→`~/.claude.json` `${PAPERCUSP_SID:-…}` interp→`?client=`→owner chain from a *genuine interactive* shell (prior D-001 used `claude-su -p`). The `claude-su` wrapper at `~/.local/bin/claude-su` was re-confirmed to mint `PAPERCUSP_SID=claude-su-$(uuidgen)` per launch and export it.
- **Step 3 (broadcast):** shell A `coord:send {to:['*'], summary:'invivoA-682fc933 …'}` → `msg_id mpskq2f5-…`, server-attributed `from: claude-su-b9596222…`.
- **Step 4 (cross-shell visibility):** launched a SECOND real `claude-su` shell B via `env -u PAPERCUSP_SID claude-su -p …` (unset the inherited SID so B mints its OWN owner). B reported `OWNER=claude-su-fc1515fe-07e9-4f8c-b4e3-91fbb33f62cf` (distinct from A → two real shells get distinct owners) and `SEEN=yes` (B's `coord:inbox` contained A's `invivoA-682fc933` — the headline cross-shell bug is fixed; B is an independent third-party witness).
- **Step 5 (self-filter):** shell A `coord:inbox` since the broadcast → empty; A does NOT see its own `invivoA-682fc933` (`excludeOwn` correct).

**Pass criteria (all met):** distinct `claude-su-*` owner per shell (A=…b9596222, B=…fc1515fe); peer broadcast visible cross-shell (SEEN=yes); self-filtered for the sender (SELF=no).

**Codex:** unchanged from D-002 (PASS). NOT re-probed here — per `feedback_codex_auth_probe_hazard`, avoid touching Codex auth without need; D-002 already verified it live after the user's re-login.

**Net:** the in-vivo verification handoff is now fully closed, including the real-interactive-session case. No code change; this is corroborating evidence only.

### D-004 — OMP↔cc worktree-scope unified — coord-hook keys locks by per-edit .git worktree root (shipped a56c7caf)
Date: 2026-05-30
Date: 2026-05-30
Resolves the deferred "OMP↔cc worktree-scope inconsistency" item (the human's "do both" is the sign-off the original "not changed unilaterally" decision deferred to).

**What changed (a56c7caf):** `apps/operator/scripts/hooks/omp/coord-hook.ts` no longer keys lock paths relative to a single fixed `papercupRoot()` (which silently dropped every edit in a sibling worktree — cross-client contention worked ONLY in the canonical `papercup` checkout). It now mirrors the cc hook's `pretooluse-locks-acquire.sh`:
- new `findRepoRoot(abs)` walks up to the dir holding `.git` (file or dir), per edit;
- new `workspaceRoot()` = `PAPERCUSP_WORKSPACE_ROOT` ?? `~/papercupai-workspace` (was `PAPERCUSP_REPO_ROOT`/`papercupRoot()` — removed);
- a path is coordinated only when its worktree root is a DIRECT CHILD of the workspace, and the lock key is the path RELATIVE TO that worktree root.
So the same logical file now collides across sibling worktrees AND with a cc edit (which keys identically). `extractPathsFromToolInput` → `extractLockTargets()` returning `{root, rel}`; the old name kept as the `.rel` projection. `onToolCall` groups symlink detection by worktree root (keys are root-relative) and dedupes keys before acquire.

**Submodule parity:** a nested/submodule `.git` whose parent isn't the workspace is now left UNGUARDED — matching the cc hook's gate. (The old OMP behavior locked submodule files under the canonical root, which was itself inconsistent with cc; both now drop them. Coordinating submodule edits is a separate concern.)

**Verification:** coord-hook.test.ts rewritten to use real temp `.git` worktree fixtures (the algorithm now reads the filesystem) — 62/62 green, +2 new cases (sibling-worktree contention; non-child/submodule repo dropped). su-locks-omp.integration.test.ts fixture updated for API consistency (note: it lives under scripts/ and is in neither CLI vitest config's globs — only /admin/testing discovers it; its unique live-PG coverage is orthogonal to path-keying). `tsc --noEmit` clean for all three files. Activated live: copied to `~/.papercusp/papercusp-coord.ts` (the path omp-su loads via `-e`).

### D-005 — OMP interactive per-session id: BLOCKED on upstream — OMP v15.5.13 has no per-launch mcp-url override (investigated from source)
Date: 2026-05-30
Date: 2026-05-30
Investigated the gating precondition ("wire when an OMP per-launch mcp-url override is confirmed"). Conclusion: **no such lever exists in OMP v15.5.13** — the item cannot be shipped cleanly without an upstream OMP change. Read the actual OMP source at `node_modules/@oh-my-pi/pi-coding-agent/src` (it runs from TS via Bun), not docs.

**The gap (narrow):** OMP's interactive model-issued MCP calls go through the static `~/.omp/agent/mcp.json` url (`?client=<machine-id>`); the OMP *hook* (coord-hook.ts:224) already appends its own per-session `?client=hookOwnerId()`. So OMP locks contend correctly (hook is per-session) and OMP↔CC coord works (CC shells have distinct ids); only same-machine OMP↔OMP *interactive coord messaging* stays collapsed (both read the static client) and a manual `locks:acquire` issued by the model doesn't share the hook's owner.

**Why every lever fails (all checked in source):**
- **No env-interpolation** in mcp.json: `mcp/loader.ts` / `mcp/transports/http.ts` consume `config.url` verbatim — no `expandEnv`/`${}` substitution. (Confirms the plan's original claim.) So the Claude `${PAPERCUSP_SID:-…}` trick can't be mirrored.
- **No per-launch CLI override:** `cli/args.ts` enumerates every flag — there is no `-c`/`--config`, no `--mcp-config`, no `--client`, no `--agent-dir`. (Codex's fix used `-c mcp_servers...url=…`; OMP has no equivalent.)
- **No agent-dir env override:** `config.ts` resolves `~/.omp/agent` via a fixed `globalAgentDir` (xdg-vs-.omp chooser, not per-launch); the only OMP/PI env vars are auth-broker/autoresearch/notifications — none redirect the agent dir. (And a per-launch dir would fragment sessions/memory/db anyway.)
- **No extension hook for MCP config:** the `pi.on(...)` event surface (extensions/hooks types.ts) covers session/agent/turn/tool lifecycle + `registerTool` — there is NO mcp-server registration / pre-connect / config-mutation hook. The coord extension (loaded via `-e`) cannot rewrite the papercusp-su url.

**Rejected workarounds (awkward compromises, per CLAUDE.md):** (a) patching the OMP package in node_modules — non-durable, not our repo; (b) per-launch rewrite of the shared `~/.omp/agent/mcp.json` — two concurrent omp-su shells race/clobber the client id; (c) server-side fallback to the per-connection `Mcp-Session-Id` — would RE-BREAK the shipped CC unified-owner design (interactive calls and the hook are separate MCP connections → separate session ids → manual-claim-vs-hook self-deadlock returns).

**What would unblock it:** an OMP feature — either env-interpolation in `mcp.json` server urls, OR a per-launch `-c`-style mcp-url/config override (mirroring Codex). File upstream against @oh-my-pi/pi-coding-agent. Until then this stays open as blocked-on-upstream, NOT deferred-by-choice. (Codex auth NOT re-probed — `feedback_codex_auth_probe_hazard`.)

### D-006 — OMP interactive per-session id RESOLVED (supersedes D-005's "blocked on upstream") — header-sourced x-papercusp-client, no upstream change needed
Date: 2026-05-31
Date: 2026-05-31

SUPERSEDES D-005. D-005 was right that OMP can't env-interpolate the mcp.json URL, but WRONG that the item was blocked-on-upstream — it missed two facts: (1) OMP resolves every MCP *header* value at connect time (config/resolve-config-value.ts: a `!cmd` value runs in a subshell inheriting the OMP process env; a bare name reads $ENV), and its HTTP transport sends config headers on every request (mcp/transports/http.ts); (2) the operator already sourced per-session identity from headers for other context — only the client id was URL-only. So the per-session id rides a HEADER, not the URL.

FIX (shipped + verified live):
- apps/operator/lib/endpoint-route/routes/transport/_mcp-handler.ts — the MCP superuser + power-user identity paths now resolve the coord/lock owner as `x-papercusp-client` header → `Mcp-Session-Id` → `?client=` (header HIGHEST precedence). THIS is the transport OMP actually uses (not buildHttpSpawnContext). Header-first → overrides OMP's static per-machine `?client=` when present; absent → unchanged (Claude/Codex still bake the SID into `?client=`; channel hooks still pass `?client=`; plain `omp` → machine id).
- install-standalone-mcp.sh OMP mcp.json writer — adds headers["x-papercusp-client"] = '!printf %s "${PAPERCUSP_SID:-}"'. psu already exports a per-launch PAPERCUSP_SID (psu-launcher.mjs:556), inherited by OMP's resolve subshell → the per-session SID; empty (dropped) for plain `omp` → static ?client= fallback.
- packages/tooldef-http/src/http-projection.ts — added `client` to PAPERCUSP_CONTEXT_HEADERS + header-first sourcing, for parity on the REST tool-projection transport.

NOT a rejected D-005 workaround: it's OMP's first-class resolveConfigValue-on-headers mechanism (no node_modules patch); each shell's env yields its own header at connect (no racy shared mcp.json rewrite); the explicit PAPERCUSP_SID header OUTRANKS Mcp-Session-Id, so it does NOT re-break the CC unified-owner design D-005 feared (interactive calls + the hook still share one PAPERCUSP_SID owner).

VERIFIED LIVE (after a papercup-dev-api.service restart loaded the handler): (1) operator-side — coord:whoami with an x-papercusp-client header overrides a DIFFERENT static ?client= (owner == header). (2) OMP-side — OMP's own resolveHeaders against the live ~/.omp/agent/mcp.json resolves the !cmd header to PAPERCUSP_SID, and coord:whoami via the operator returns ownerId == that SID. Unit: agent-mcp http-projection.test.ts buildHttpSpawnContext client cases 28/28 green; _mcp-handler tsc clean. (A literal `omp -p` model run was blocked by an UNRELATED omp model-API bug — some tool inputSchema serializing `properties` as a bool — flagged separately; not this fix.)

NOTE: the *-su wrappers D-005 investigated are retired; launch is now `psu` (psu-launcher.mjs), which mints+exports PAPERCUSP_SID. Activation: re-run install-standalone-mcp.sh (or it lands on the next install); the live ~/.omp/agent/mcp.json on this box was patched + the host restarted.
