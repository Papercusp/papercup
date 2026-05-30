---
title: Three-client file-lock enforcement (Claude · Codex · OMP)
slug: three-client-lock-enforcement-2026-05-30
created: 2026-05-30
updated: 2026-05-30
status: shipped
---

## Now

**State:** **Shipped + activated.** All three clients now enforce SU-locks. Merged to `main` (merge `ab589a2d`) and the installer was run on this host: the shared `cc/` hooks live in `~/.papercusp/hooks/cc/`, wired into `~/.claude/settings.json` (Claude, matcher `Edit|Write|MultiEdit`) and the codex-su `CODEX_HOME/settings.json` (Codex, matcher `apply_patch|write_file|edit_file`, wrapper carries `--dangerously-bypass-hook-trust`); OMP via `omp-su -e`. Verified end-to-end against the live operator (acquire → contended `deny` → release for both `Edit` and `apply_patch` shapes; workspace scoping; fail-open) and the hook was observed blocking a real edit in a live session.

**Per-session identity — FIXED for `-su` (option (a), the unified-id approach).** Root cause was broader than first thought: all same-machine SU sessions collapsed to the static `?client=<machine-uuid>`, so (1) `coord:inbox` self-filtered peers' broadcasts (a peer's message looked self-sent) AND (2) the manual-acquire owner differed from the hook owner → manual-claim self-deadlock. Fix: each `-su` wrapper mints a per-launch `PAPERCUSP_SID`; the interactive MCP `?client=` carries it (Claude via `~/.claude.json` `${PAPERCUSP_SID:-<machine-id>}` env-interpolation; Codex via a `codex-su -c mcp_servers.papercusp-su.url=…&client=$SID` override) AND the cc hook reads the SAME `PAPERCUSP_SID` as its owner. So within a shell, interactive calls + hook share one owner (manual claims no longer self-block); across shells, ids are distinct (coord no longer self-filters). Plain `claude`/`codex` (no env) fall back to the machine id → unchanged. `identity.ts` / `_mcp-handler.ts` untouched — we just feed `?client=` a per-session value. Verified: two distinct SIDs contend even with identical `session_id`; the SID → session_id → agent_id fallback chain works.

**OMP deferred:** OMP doesn't env-interpolate `~/.omp/agent/mcp.json`, so its interactive coord/lock calls still use the static machine id (OMP's *hook* already mints a per-session id, so OMP locks contend correctly; only OMP↔OMP *coord messaging* between same-machine shells stays collapsed). Wire when an OMP per-launch mcp-url override is confirmed.

**OMP↔cc worktree-scope inconsistency (deferred, assessed 2026-05-30 — flagged, not changed):** the cc hook keys lock paths relative to *any* direct-child worktree of `~/papercupai-workspace` (it walks up to `.git` per edit, then workspace-scopes), but the OMP `coord-hook.ts` keys on a SINGLE `papercupRoot()` (`coord-hook.ts:951`, default `~/papercupai-workspace/papercup` / `PAPERCUSP_REPO_ROOT`). So cross-client contention works when OMP runs in the canonical `papercup` checkout (same repo-relative key as a cc edit) but is LOST when an OMP agent edits a *sibling* worktree (OMP skips it; a cc client there would lock it). Narrow (OMP agents usually run in the canonical checkout). **Decision: not changed unilaterally** — `coord-hook.ts` is the `file-locking-improvements-2026-05-20` plan's artifact with its own path-normalization tests (`coord-hook.test.ts`) and careful identity design; broadening its scoping risks regressing that. Fix = mirror the cc hook's per-edit `find_repo_root` + workspace-scope in `coord-hook.ts`, with that plan owner's sign-off + test updates.

**Next:** the in-vivo verification handoff below, then OMP interactive per-session id, then (low) the OMP↔cc worktree-scope unification above.

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
