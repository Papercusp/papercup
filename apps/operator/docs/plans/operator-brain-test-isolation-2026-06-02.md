---
title: Operator brain isolation for headless LLM-scenario testing
slug: operator-brain-test-isolation-2026-06-02
status: ready
created: 2026-06-02
updated: 2026-06-02
owner: aviynw@gmail.com
companion-to: [voice-production-test-coverage-2026-06-01]
---

# Operator brain isolation for headless LLM-scenario testing

## Now

**State:** Live `npm run llm-test` runs return **`turns=0` for EVERY operator scenario** (verified on S01 too, not just the new voice ones) on a dev box. Root-caused: the embedded operator brain's `claude-code` spawn inherits the developer's `~/.claude` environment, so it behaves like a general Claude Code agent instead of the operator persona. The voice-scenario authoring + the test-framework plumbing are already DONE (see companion plan `voice-production-test-coverage-2026-06-01`, P-019 + commit `7ddd7815a`); this plan is the ONE remaining piece to make live scenario runs green for all scenarios.

**Next:** Add a brain-spawn isolation seam (clean per-spawn `CLAUDE_CONFIG_DIR`/`HOME` + credential symlink, à la the existing codex backend) scoped to the operator brain only, then re-run S01 + the 4 voice scenarios live.

## Background — what's broken (definitive, 2026-06-02)

The LLM-test SUT is the operator brain, reached via `POST /api/agent-mcp/operator-converse` → `lib/agent-tools/operator/converse.ts` → `runAgentChat({ backend, … })` in `libs/papercup-shared/src/agent/chat-stream.ts` (a SUBMODULE; resolves to `src/` via tsx, no build). On this dev box `AGENT_BACKEND=claude-code`, so the brain spawns the `claude` CLI.

The claude-code branch (`chat-stream.ts`, the `if (backend === 'claude-code')` block ~line 530) builds `claude -p --output-format stream-json … --mcp-config <operator tools> --permission-mode bypassPermissions` and runs it with `spawnEnv = process.env` — i.e. the **developer's full `~/.claude`**:
- the `SessionStart` superpowers hooks (inject a big "you have skills, use them" context),
- the box's MCP servers from `~/.claude.json` (`coord_*`, `harness_*`, `papercusp-su`, claude-in-chrome, …) — `--mcp-config` does NOT replace these (this `claude` version has no `--strict-mcp-config`),
- built-in `Read`/`Bash`.

With `permissionMode: 'bypassPermissions'`, the brain then goes **agentic**: it calls `coord_watermark`/`harness_status`/`Read` of `~/.claude/.../tool-results/*.json` etc. instead of emitting a clean `<say>` turn. The runner (`lib/llm-testing/targets/operator.ts`) never gets a usable operator turn → `turns=0` → the judge correctly returns `meta: "environment/SUT-health failure, not an operator behavioral finding."`

Proof points captured:
- Direct `curl operator-converse` with `mayAskActive:false` → a clean `<say>The operator is a Tauri desktop app…</say>` ($0.04, 13s). With the runner's body (`mayAskActive:true`, `uiClientId`, `conversationId`) → agentic (tool_calls + markdown).
- S01 (existing text scenario) also returns `turns=0` → framework-wide, NOT a scenario bug.

## Phase 1 — the isolation seam

- **P-001** `todo` Add a per-spawn isolation option to the claude-code backend in `libs/papercup-shared/src/agent/chat-stream.ts`. When set, point the `claude` spawn at a CLEAN config (set `CLAUDE_CONFIG_DIR` — or `HOME` — to a fresh `mkdtempSync` dir in `spawnEnv`, mirroring the existing `codexHome` pattern at ~lines 577–601) so it loads NONE of the host `~/.claude` (no SessionStart hooks, no `~/.claude.json` MCP servers, no skills) and sees ONLY the operator's `--mcp-config` tools + its persona system prompt. Clean up the tmpdir on child exit (alongside `ompAgentDir`/`codexHome`).
- **P-002** `todo` Preserve auth: the clean config dir must still authenticate. Find where the `claude` CLI stores credentials on this box (likely `~/.claude/.credentials.json`; may be an OS keychain) and **symlink it into the clean dir** (exactly like codex symlinks `~/.codex/auth.json`). If auth is keychain-only and can't be relocated, fall back to a real `ANTHROPIC_API_KEY` for the brain spawn.
- **P-003** `todo` Scope it to the operator brain ONLY: add the option to `RunAgentChatOptions` and have `lib/agent-tools/operator/converse.ts`'s `runAgentChat({…})` call pass it. Do NOT change the stateless sim/judge path (`lib/llm-testing/llm-client.ts`) — it already works on claude-code (no isolation needed for one-shot completions).
- **P-004** `todo` Restart the operator after editing the submodule (`:3070` host = `systemctl --user restart papercup-dev-api.service`; tsx, no hot-reload), then verify (see Decisions for exact commands). On success, commit the submodule + pin in the superproject.

## Decisions

### D-001 — Ruled-out dead-ends (do NOT repeat)

Date: 2026-06-02.
- **`--bare`** (skip hooks/LSP/plugins): suppresses the SessionStart hooks (8→1) BUT *breaks the brain subprocess* in the operator's spawn context — with `--bare` the brain returns `"operator brain produced no output (agent backend failure)"`, and it broke the sim/judge llm-client calls (exit 1) when applied blanket. It does NOT drop the host MCP servers (the bigger driver). Abandoned + reverted.
- **`AGENT_CMD` double-flag**: `.env.local` sets `AGENT_CMD="claude -p --model haiku"`, which double-adds `-p`/`--model` on top of the branch's own flags. A red herring — fixing it (`agent-config cmd='claude'`) did NOT change `turns=0`. (Note it returns on every restart because it's a launch-env value.)
- **`--strict-mcp-config`**: not present in this `claude` CLI version, so you can't restrict MCP via a flag — hence the clean-config-dir approach in P-001.

### D-002 — Verified-working pieces (build on these)

Date: 2026-06-02.
- The LLM-test framework runs the **sim-user + judge** live on **claude-code + haiku** after commit `7ddd7815a` (`lib/llm-testing/llm-client.ts`): `LLM_TEST_BACKEND` env selects the backend + `messages` are flattened into `promptText` (subprocess backends ignore `messages`). Use the model alias **`haiku`** (NOT `claude-haiku-4-5` — the `claude` CLI rejects the latter).
- The operator brain itself WORKS for a plain turn (direct curl produced a clean `<say>`). The only failure is the agentic-inheritance above.
- The 4 voice scenarios `op-S13..S16` are authored, registered in `lib/llm-testing/scenarios/index.ts`, and **lint-clean** (`npm run llm-test -- lint`).

### D-003 — Exact verification recipe

Date: 2026-06-02. Prereqs: operator running on `:3070`; an Anthropic/Claude-Max session (the `meridian` router on `:3456` works but is rate-limited on sonnet — `meridian` binary on PATH, `~/.omp/agent/auth.json` present). The brain's own model is operator agent-config `models['operator']` (default pin: `anthropic/claude-opus-4-7`); set it to haiku for testing via `POST /api/agent-config {backend:'claude-code', cmd:'claude', models:{operator:'haiku'}, backends:{}, surfaceModels:{}}` (full-replace; restore `cmd:''`/`models:{}` after).

Smoke (existing text scenario — fastest signal that the SUT now yields turns):
```
LLM_TEST_BACKEND=claude-code LLM_TEST_SIM_MODEL=haiku LLM_TEST_JUDGE_MODEL=haiku \
  PAPERCUSP_LLM_TEST_SKIP_CLAIM=1 \
  npm --prefix apps/operator run llm-test -- --scenario op-S01-status-quick --no-matrix --no-persist
```
Expect `turns >= 1` and S01's asserts (`harness:status` called, `<continue/>`) to be EVALUATED (pass/fail), not the `meta` inconclusive error. Then run the voice four: `op-S13-voice-terse-complex`, `op-S14-voice-no-code`, `op-S15-voice-error-recovery`, `op-S16-voice-disambiguation`. `--no-matrix` is N=1 (cheap); drop it for the full 3× variance matrix. `PAPERCUSP_LLM_TEST_SKIP_CLAIM=1` bypasses the per-scenario parallel-claim (stale claims linger from crashed runs).
