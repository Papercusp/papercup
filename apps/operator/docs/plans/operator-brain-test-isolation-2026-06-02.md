---
title: Operator brain isolation for headless LLM-scenario testing
slug: operator-brain-test-isolation-2026-06-02
status: shipped
created: 2026-06-02
updated: 2026-06-02
owner: aviynw@gmail.com
companion-to: [voice-production-test-coverage-2026-06-01]
---

# Operator brain isolation for headless LLM-scenario testing

## Now

**SHIPPED 2026-06-02 (commit `433ff44dd`).** Live `npm run llm-test` now produces real,
evaluated operator runs instead of `turns=0`/SUT-health failures. The root cause was
**deeper and five-fold** — the original "host `~/.claude` inheritance" hypothesis (below)
was correct but only 1 of 5 issues. Full breakdown + verification in **§ Outcome**. The
companion voice scenarios (`op-S13..S16`) now run and the judge evaluates real voice
behavior (S14 passes; S13/S15/S16 surface genuine voice-format findings). Done.

## Outcome (2026-06-02) — five root causes, all fixed

Live runs failed for FIVE distinct reasons in the `claude-code` backend, found by
working down from the `turns=0` symptom. All fixed in `433ff44dd`
(`libs/papercup-shared/src/agent/chat-stream.ts` swept into submodule `ab91f94`;
`converse.ts`, `llm-client.ts`, `llm-testing/targets/operator.ts`):

1. **Host `~/.claude` inheritance** (the original hypothesis). The brain spawn ran with
   `spawnEnv = process.env`, so it loaded the dev box's MCP servers + SessionStart/plugin
   hooks + built-ins → went agentic. **Fix:** `isolateConfig` option → clean per-spawn
   `CLAUDE_CONFIG_DIR` (tmpdir) holding only a symlink to the real
   `~/.claude/.credentials.json` (OAuth carries over; mirrors the codex `auth.json` symlink).

2. **The persona was SILENTLY DROPPED.** The `claude-code` branch never passed any
   `--system-prompt` flag (only `omp` got `--append-system-prompt`), so `systemPromptText`
   (the 59 KB operator persona) never reached the model — the brain ran as the *default
   Claude Code coding agent*. This is why it "went agentic" even harder than #1 alone
   explains, and why the sim-user replied "what would you like to work on?". **Fix:**
   pass the persona via `--system-prompt-file` (REPLACE, matching the meridian backend's
   `params.system = systemPromptText`).

3. **It read the repo `CLAUDE.md`** via the spawn cwd (= repo root). **Fix:** isolated
   spawns run with cwd = the clean config dir (no project `CLAUDE.md`).

4. **The sim-user + judge spawns were ALSO non-isolated** (the `llm-client` path D-002
   said "already works" — it did not). Each did a 13-server MCP init (context7/github/
   cloudflare plugins via npx) + host hooks; under the concurrent sim+judge+brain load
   they flaked/`exited 1`, so the sim-user emitted unparseable output and gave up at
   turn 0. **Fix:** `llm-client.ts` passes `isolateConfig` too (no-op for `meridian`).

5. **Workspace mismatch → tool-less brain.** With #1–#4 fixed the brain had its persona
   but still deflected on every tool. `converse.ts` gates `mcpConfig` on
   `principalOk = readSystemPrincipal('operator') && ws match`. The LLM-test target sent
   no workspace, so `activeWorkspaceId()` resolved to `registry.current` =
   **`papercusp-workspace`**, which has **no operator system principal** (principals +
   the scenario harnesses live in **`default`**) → `mcpConfig=undefined` → the brain ran
   **tool-less**. **Fix:** the operator target stamps `x-papercusp-workspace=default`
   (overridable via `PAPERCUSP_LLM_TEST_WORKSPACE`). See agent-insight
   `llm-test-operator-workspace-principal`.

### Verification (haiku brain, sim+judge haiku, `--no-matrix`)

- **S01** `op-S01-status-quick`: `turns=4`, `harness:status` **called** (assert passes),
  judge gives real behavioral findings (operator over-asks instead of `<continue/>`) —
  NOT the `meta` inconclusive error. The D-003 success criterion is met.
- **Voice:** `op-S14-voice-no-code` **PASSES**; `op-S13`/`op-S15`/`op-S16` run and fail on
  **genuine voice findings** (say-blocks 246/225/301 > 220-char cap; S16 didn't surface a
  voice-answerable choice card; S15 over-asks + acts without user direction). These are
  real production-readiness signals for the voice persona, not test-infra failures.

### Follow-ups (NOT part of this plan — surfaced for the owner)

- **Brain model pin — opus is too SLOW for voice (measured 2026-06-02).** Production
  default is `anthropic/claude-opus-4-7`; the `.env.local` `AGENT_CMD="claude -p --model
  haiku"` override is *dead* (the branch's own `--model` wins, last-flag), so the brain
  actually runs on opus. One-turn latency: **haiku ~21 s, sonnet ~17 s, opus ~100 s.** Opus
  blows the voice scenarios' 90 s `maxWallSecs` + the 90 s initial-event timeout, and 100 s
  of dead air is an unusable voice UX. **Recommendation: run the voice surface on `sonnet`**
  (fast + capable) — set it via agent-config `models['operator']` (or a voice surface
  override), NOT AGENT_CMD. See agent-insight `llm-test-operator-workspace-principal`
  → "Brain model: latency vs compliance".
- **Voice persona findings.** Cross-model (haiku→sonnet→opus) results: haiku's over-length
  `<say>` (246/225/301 > 220) was a model artifact — **resolves on sonnet**; S15 fails on
  haiku but **passes on sonnet**. Persistent on sonnet: `oneQuestionMarkPerTurn` (S13 stacked
  2 questions — deterministic), `cardUsage` (S16 didn't surface a voiceAnswerable
  disambiguation card — sonnet skips it, opus uses it), one 222-char overrun. These are
  operator voice-persona tuning items (the persona already states the rules at
  `operator-converse-prompt.ts:201` etc.), **not** isolation-plan work — flagged for the
  voice-production owner.

---

## Original plan (for reference — the "Next" below is superseded by § Outcome)

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

- **P-001** `done` Per-spawn isolation option (`isolateConfig`) added to the claude-code backend: clean `CLAUDE_CONFIG_DIR` tmpdir + tmpdir cleanup on exit. (chat-stream.ts)
- **P-002** `done` Auth preserved: symlink `~/.claude/.credentials.json` into the clean dir (OAuth carries over; no API key needed). Credentials are a file here, not a keychain.
- **P-003** `done` (REVISED) `isolateConfig` wired to `converse.ts` (brain) AND `llm-client.ts` (sim/judge). D-002's "sim/judge already work" was WRONG — they flaked under load (root cause #4 in § Outcome), so they needed isolation too. Plus two issues the original plan didn't anticipate: `--system-prompt-file` (#2) and the `x-papercusp-workspace` header (#5).
- **P-004** `done` Host restarted; S01 + all 4 voice scenarios run live; submodule committed (`ab91f94`) + pinned. See § Outcome → Verification.

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
