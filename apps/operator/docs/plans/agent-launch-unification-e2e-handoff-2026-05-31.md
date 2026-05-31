# Successor brief — agent-launch-unification: live e2e + deferred follow-ups

**Date:** 2026-05-31
**From:** Claude Code SU session (transcript:
`/home/marsh-office/.claude/projects/-home-marsh-office/c18febde-f62c-41f2-a11c-fc0483500d8f.jsonl`)
**Plan of record:** `apps/operator/docs/plans/agent-launch-unification-2026-05-30.md`
**Reference map (read first):** `apps/operator/docs/plans/agent-backend-refactor-handoff-2026-05-30.md`
— §2 two-backend-systems model, §7 how to live-test codex, §8 LANDMINES,
§9 file index. *Don't re-derive what's in there.*

---

## TL;DR

The unified plan is **code-complete across all 5 phases**. Every item that
can be built and unit-verified from a headless session is shipped and
committed on `main`. What's left is **purely verification that requires the
desktop running on this code** (plus a fresh codex login), and **two
follow-ups that are deliberately gated on that verification**.

Your job, in order:

1. Bring up the Tauri desktop shell on this code.
2. Run the four live e2e checks below (P-013, Phase 3, Phase 4, P-041 UI).
3. **Only after** they pass: do the two deferred items (P-032 omp→psu
   convergence; codex interactive role sessions).

If an e2e check fails, that's the real work — fix the wiring, don't paper
over it. The deterministic parts are unit-tested green; the live spawn
paths are the unverified surface.

---

## Already verified live (2026-05-31, do NOT redo)

The build session's desktop was up on this exact code (host PID started
*after* every relevant commit — confirmed by start-time vs commit-time). The
following were checked live against `:3070`/`:3055` and need no repeat:

- **45 unit tests green** — guardrail set: `agent-backend-sync` (4),
  `launch-agent` (5), `role-launch-spec` (3), `bootstrap-role` (6); plus
  `psu-launcher` (20), `adv-sessions` (4), `adv-sessions-link` (3).
- **P-041 backend round-trip** — POST `surfaceModels.oracle` to
  `/api/agent-config` → GET returns it → reset to `{}`. The route +
  `parseSurfaceModels` + storage + snapshot all work. **Still pending:** the
  `/settings/agent` *widget* driving this in the actual webview (data path
  behind it is proven).
- **bootstrap-role route is mounted + principal-gated**, and 4 validation/gating
  paths return correctly: invalid-role → 400; **codex → 400
  `codex_role_unsupported`** (the deferred gate is in place); **worker without a
  feature → 400 `feature_required`** (proves `roleConsumes('worker')` =
  `feature:'required'` against the live registry); missing harness_slug → 400.
- **Options endpoint (the picker's whole data layer) live** —
  `GET /api/agent-mcp/console/bootstrap-su/options` (bare) returns 28 roles
  **each with `consumes`** (`worker`→`{feature:required,plan:none}`,
  `scoper`→`{feature:none,plan:optional}`), 6 workspaces (+activeWorkspace), and
  the harness list; `?harness=papercup&features=1` returns 19 features. So the
  role/workspace/feature pickers (P-023) and the `consumes` single-source (P-002)
  are end-to-end correct on the wire — only the interactive launch they feed is
  unverified.
- **CLI flags parse-verified against the installed binaries** (a flag-name bug
  would fail launch regardless of auth, so this was worth closing):
  - **claude 2.1.158** accepts `--append-system-prompt-file` AND
    `--strict-mcp-config` (parse-tested via `claude <flag> --help` → exit 0, no
    "unknown option"). The claude role-launch args in `roleLaunchArgs` are sound.
  - **omp** parse-accepts the space-form `--approval-mode yolo
    --append-system-prompt <path>`; its help documents `--append-system-prompt`
    as "text **or file contents**" (distinct from MESSAGES, which need an `@`
    prefix). The launcher passes a bare file path relying on that auto-detection
    — the **one omp-role detail still to confirm live** (does omp read the
    file's contents vs inject the path string?).
  - **codex-cli 0.135.0** `exec` has every flag invoke.ts passes
    (`--json --skip-git-repo-check --ephemeral -s <mode>
    --dangerously-bypass-approvals-and-sandbox -m <model>`), and the trailing
    `-`-positional + piped-stdin prompt pattern matches the **live-verified**
    chat-stream codex brain path (chat-stream.ts:550) — so it's correct by
    parity. invoke.ts's extra sandbox-bypass (absent in chat-stream) is the
    deliberate pipeline-agent addition (§8: without it codex cancels MCP calls).
- **Code audit of all four new surfaces — no bugs found**: `bootstrap-role.ts`,
  `psu-launcher.mjs`, `launch-su.ts`, and the `invoke.ts` codex path. The
  remaining items are genuine live-behavior gates, not latent defects.
- **D-001 tool-scoping at dispatch — LIVE-VERIFIED** (this was the keystone gap).
  Ran `spawn-signing-e2e.integration.test.ts` against the live operator: 10/10
  pass, including **signed `role=worker` URL → role-filtered tool list** (no
  `autoloop:control`), **worker calling operator-only `autoloop:control` →
  `role_not_allowed`**, operator role *can* call it, tampered role →
  `invalid_signature`, expired → rejected, unsigned+claimed → empty list, audit
  row written on tamper. This is the exact dispatch-layer enforcement
  `buildRoleLaunchSpec`'s signed URL depends on; since its param set is a subset
  of the test's `SIGNED` set (`{harness,workspace,role,run,spawn,feature,…}`),
  its URLs verify and scope identically. NB: this test reads the signing key via
  `psql -h localhost -p 5432 -d papercusp` — correct on THIS dev box (native PG
  `:5432/papercusp` is the live store; no `papercusp_legacy` here), but it would
  need an embedded-pg DSN on a desktop-embedded-pg box. If it skips/fails on your
  box, that's the topology difference, not a regression.

**NOT yet verified (still your job — needs terminal / codex auth / Tauri UI):**
the bootstrap-role *happy path* against a real harness was deliberately skipped
(it writes a signed `.mcp.json` into a shared-checkout harness cwd — risky to do
casually; the happy path is unit-tested with a temp cwd). The genuinely-live
gaps remaining are now narrower than before:
- **Phase 3 interactive-launch plumbing** — that `psu --role=worker` actually
  execs claude/omp which connect to the role-scoped `.mcp.json` and open a
  working session with `FEATURE_ID` set, tracked in /adv. The **tool-scoping
  guarantee itself is already proven** (D-001 above) — what's left is confirming
  the CLI picks up `--mcp-config`/path-discovery and connects.
- **codex** — P-013 (codex worker pipeline) + codex interactive role; both need
  a fresh codex login (token revoked).
- **UI widgets** — Phase 4 launch buttons + the P-041 `/settings/agent` model
  input, driven in the actual webview.

---

## Step 0 — bring the app up (REQUIRED; do not skip)

Per repo rules, the **only** supported run/test surface is the Tauri shell.
Do **not** open `:3055`/`:3070` in a browser, and do **not** start
`apps/operator` standalone (native PG is renamed `papercusp_legacy` to fail
loud).

```bash
cd /home/marsh-office/papercupai-workspace/papercusp-desktop && npm run dev
```

This boots embedded PG, applies migrations, starts the operator sidecar, and
opens the webview. The `:3070` Hono host has **no hot-reload** — if you edit
anything under `apps/operator/lib/**`, reload the Tauri window (Ctrl+R) or
restart the dev box service before re-probing, or you'll test stale code.

For agent-driven UI checks read `/internal/docs/testing` +
`/internal/docs/testing/agent-e2e` and drive via `tauri-agent-tools`
(probe→eval/click/check/capture). A `curl http://127.0.0.1:3070/...` is fine
for an **API** check while the desktop is up, but is **not** sufficient for a
UI check.

### codex auth — verify BEFORE the codex checks

`~/.codex/auth.json` exists but its OAuth token was **revoked** when probed
during the build session (`token_revoked` / `refresh_token_reused`). codex
uses ChatGPT OAuth, no API key. **Re-auth first** or every codex check will
fail at the model call for an unrelated reason.

⚠️ **LANDMINE (from memory `feedback_codex_auth_probe_hazard`):** codex
refresh tokens rotate and are single-use. Do **not** copy `auth.json` into a
throwaway `CODEX_HOME` to "test" it — that can log the user out. To re-auth,
have the user run codex login interactively (suggest they type
`! <codex-login-command>` in their session so output lands here). Inspect the
codex binary with `strings`, never by spawning a probe that touches the live
auth.

---

## The four live e2e checks

### 1. P-013 — codex worker in the orchestrator pipeline
**Goal:** a real codex `worker` on a feature streams a result **and** fires
at least one MCP `tool_call`.

- Config: per-role codex via the harness `.harness/config.json`
  `aiBackend.roles.worker.agentCmd = 'codex'` (consumed by `resolveAgentForRole`
  + the codex spawn path in `invoke.ts`).
- Spawn path: `libs/papercusp/packages/orchestrator/src/invoke.ts` codex branch
  — `codex exec --json` + unconditional sandbox bypass
  (`-s danger-full-access --dangerously-bypass-approvals-and-sandbox`), prompt
  via stdin `-`, model via `-m` (bare id), per-spawn `CODEX_HOME` minted by
  `writeSignedSpawnCodexHome` (`spawn-mcp.ts`) carrying the **signed
  role-scoped** MCP URL (sig-auth, no bearer) + an `auth.json` symlink.
- Result parsing: `extractResult` concatenates `item.completed` /
  `agent_message` text from the JSONL so `parseDecision` works.
- **What to verify live:** result text comes back non-empty AND the run shows
  a tool_call. The deterministic flag-building + JSONL parsing are unit-tested
  (5 tests in the orchestrator); the **spawn wiring itself is UNVERIFIED-live**
  — it mirrors the live-verified chat-stream codex reference but has never run
  end-to-end in the pipeline. See handoff §7 for the codex live-test recipe and
  §8 for the sandbox/tool-call shape landmines.

### 2. Phase 3 — psu interactive role session, role-scoped tools
**Goal:** `psu --role=worker --feature=<F>` opens a worker session whose tools
are **actually scoped to the worker role** (not operator/superuser), with
`FEATURE_ID` set, tracked as an /adv row tagged `worker·<F>`.

- Entry: `psu` shim (`~/.local/bin/psu`) → `apps/operator/scripts/psu-launcher.mjs`.
  Role-first picker: role → backend(claude|omp) → workspace → harness →
  feature (iff the role `consumes` a feature) → launch. `--role` / `--feature`
  / `--backend` are preselectable.
- Server: `POST /api/agent-mcp/console/bootstrap-role`
  (`lib/endpoint-route/routes/agent-mcp/bootstrap-role.ts`) → `buildRoleLaunchSpec`
  (`lib/role-launch-spec.ts`) writes a signed role-scoped `.mcp.json` + the role
  prompt file, records the `adv_sessions` row (role+feature+agent).
- **The scoping is the point (D-001) — ALREADY PROVEN, see "Already verified
  live".** The role `.mcp.json` uses a `signSpawnParams`-signed URL carrying
  `role=worker`, **not** `?superuser=1`; the dispatch layer rejects non-worker
  tools (verified live via `spawn-signing-e2e.integration.test.ts`: worker →
  `role_not_allowed` on `autoloop:control`). claude is launched with
  `--strict-mcp-config` so only that config's server is available. So you do NOT
  need to re-prove the scoping — you only need to confirm the **launch plumbing**:
  that the claude/omp process actually starts, connects to the `.mcp.json`, and
  the session shows `FEATURE_ID` + a /adv row. (If you want belt-and-suspenders,
  inside the launched session ask the agent to call an operator-only tool and
  confirm it's refused.)
- Then repeat once on the **codex** backend — but note codex interactive role
  sessions are currently **400'd on purpose** (see deferred item B); for now
  Phase 3 verification is claude + omp only.

### 3. Phase 4 — launch buttons route through the dispatcher
**Goal:** the launch buttons on the claude/codex paths work end-to-end.

- Dispatcher: `lib/launch-agent.ts` `launchAgent({ agent, ... })`. `omp` →
  unchanged `launchOmpAgent` path (model/kickoff/resume preserved, byte-identical
  — low regression risk). `claude`/`codex` → `POST /adv/sessions/launch-su`
  (`lib/endpoint-route/routes/adv/launch-su.ts`) → psu → `*-su` wrapper.
- 6 call sites route through it: PlanActions, PlanItemPreview, PlansClient,
  AgentLauncherButton, AdvSessionsClient (×3). 6 dispatch unit tests green.
- **What to verify live:** clicking launch for **claude** (and **codex**, once
  re-authed) actually opens a tracked session. omp is the default and unchanged;
  the new capability is claude/codex.

### 4. P-041 UI — per-surface model column round-trips
**Goal:** `/settings/agent` → "Per-surface backend + model" → set a model for
a surface → Save → reload → it persists, and that surface's brain uses it.

- File: `apps/operator/app/settings/agent/page.tsx` (commit `407094cf`).
  Load hydrates `surfaceModels` from `d.config.surfaceModels`; onSubmit posts
  non-empty entries; render shows a `model (optional)` input per surface row.
- Consumption is already wired (commit `6c9db80e`): `surfaceModel()` feeds all
  8 brain surfaces (converse/oracle/scanner/delegate/architect/brainstorm/
  agent_chats/plans), additive (`surfaceModel ?? existing`) — a no-op until set.
- **What to verify live:** the value survives a reload (round-trips through
  `/api/agent-config`), and ideally that a surface with an override actually
  invokes that model.

---

## After the e2e passes — the two deferred follow-ups

### A. P-032 — retire the legacy omp-only console-launch path
Once Phase 4 e2e confirms claude/codex launches **and** the psu path reaches
model/kickoff/resume parity with the omp builder: delete
`buildEngineerOmpLaunchCommand` + the console-launch `mode:'omp'` branch and
converge omp onto psu too (so all three agents share one launch path). Until
then the omp builder stays as the default fallback behind `launchAgent` — do
**not** delete it before the e2e is green. blocked-by: Phase 4 e2e.

### B. codex interactive role sessions
`bootstrap-role.ts:122-123` currently returns `400 codex_role_unsupported`.
The CODEX_HOME machinery from Phase 2 (`writeSignedSpawnCodexHome`) is reusable
for interactive sessions. Once P-013 confirms the codex spawn path works live,
lift the 400 and wire codex through the psu role flow the same way claude/omp
go. blocked-by: P-013.

---

## Guardrails / unit tests to keep green

Run after any edit (these are the drift guards for this arc):

```bash
cd apps/operator
npx vitest run agent-backend-sync     # the 3-tuple drift guard across the submodule edge
npx vitest run launch-agent           # 6 dispatch tests
npx vitest run role-launch-spec       # 3 tests
npx vitest run bootstrap-role         # endpoint tests
# or the walker:
cd /home/marsh-office/papercupai-workspace/papercup && npm run test:affected
```

## Repo discipline (don't get bitten)

- **Work on `main` directly** in `/home/marsh-office/papercupai-workspace/papercup`
  — no branches/worktrees, don't push. **Commit `--no-verify` before ending
  every turn** (paperclip + other agents rewrite uncommitted files). Recover a
  stomp with `git checkout -- <path>` (only works if you committed).
- **Locks are automatic** via the PreToolUse hook on Edit/Write; if it tells you
  a file is held, redirect — don't retry the same edit.
- **Submodule commit order** (handoff §8): commit inside the submodule
  (`libs/papercusp`, `libs/papercup-shared`) **first**, then bump the superproject
  pointer. Path-scope your `git add` — `git commit` packages the whole index,
  and other agents' staged changes ride along otherwise.
- Submodule pins are **local-only** (not on origin) — don't push without asking.

## Recovering context

Read the build session's plan-of-record `Now` block first; it's current as of
commit `2c590722`. If you need the reasoning behind a specific decision, the
Claude Code transcript is at the path in the header, and the design rationale
is in the reference handoff (§2/§7/§8/§9). The locked decisions (D-001 signed
per-spawn URL for role scoping; D-002 `consumes` in the role registry; D-003
one `buildRoleLaunchSpec`) are in the plan's Decisions section — don't relitigate.
