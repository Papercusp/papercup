# P5 live-triage handoff — 2026-05-21

Handoff brief for the next agent picking up the operator-behavior-tests
(plan: `operator-behavior-tests-2026-05-14.md`). Written after the
prior agent over-claimed a root-cause conclusion; this doc separates
**verified** from **hypothesis**. Trust nothing here without re-checking.

## Where the plan stands

Phases P1–P4 (framework extensions + 12 `op-M*` scenarios + plan doc)
were committed in earlier sessions. **P5 = the live triage run** is the
only open phase. This session attempted P5.

## Verified facts (re-confirmed with real commands this session)

1. **operator-converse on `:3070` works** — it produces real operator
   turns. M1–M5 ran with real cost ($0.024–$0.118) and real multi-turn
   transcripts in `harness_shared.llm_test_runs`.
2. **Topology after the Vite migration:** `:3055` = Vite SPA frontend
   (proxies `/api` → `:3070`); `:3070` = `bin/hono-host.ts`, the API
   backend that serves operator-converse. The framework's
   `OperatorTarget` was repointed to `:3070` (commit `75215108`).
3. **First P5 batch (this morning, ~09:16–09:35):** M1–M5 ran for real
   and `failed`; M6–M12 `errored` fast (~11–48s, ~$0). Host log showed
   `omp exited 0 with EMPTY output`. Root cause of the M6–M12 errors:
   the operator backend hit a **Claude Max session limit**
   (`resets 11:40am ET`) partway through. The framework's SUT-health
   gate correctly labeled them `errored` + `meta` finding — NOT
   operator behavioral findings. This is the gate working as designed.
4. **At 13:14 ET the session limit had reset** — a direct
   `omp ... --model anthropic/claude-opus-4-7` test produced clean
   output (`pong`, `stopReason:stop`, $0.20).
5. **M1–M5 judge findings (real PG data)** consistently report:
   *"telemetry shows 0 tool calls — the assistant fabricated all
   harness details — hallucination of system state."* Rubric scores
   confirm: `tools` 0–1.5 and `groundedness` 0–1.5 across all five.
   Deterministic assert violations: M1 no `<continue/>`; M3 never
   called `harness:list`; M4 stacked 2 questions in turn 2; M2 & M5
   had no assert violations (judged only).
6. **The agentmcp MCP config is correct on disk.** A live omp-chat
   spawn dir had `mcp.json` with
   `agentmcp → http://127.0.0.1:3070/api/mcp?...` (HTTP type, Bearer
   auth) and `config.yml` with `mcp.discoveryDefaultServers: [agentmcp]`.
7. **The agentmcp endpoint returns tools** — a direct
   `POST :3070/api/mcp {tools/list}` returned `harness:list`,
   `harness:get`, `harness:status`, `tasks:list`, … with full schemas.
8. **M6–M12 were re-run at ~13:17–13:19** after the limit reset. All
   7 exited `1`. **Their PG rows were NOT inspected** — see "unknown".

## The central operator finding (verified symptom, UNverified cause)

**Symptom (verified):** across M1–M5 the operator brain runs, emits
operator-shaped output (`<say>` etc.), but makes **zero tool calls**
and **fabricates harness state** (plugin versions, worktree names,
workspace lists, file paths, feature IDs — all invented). This is a
severe, real operator defect: the operator is non-functional for any
real task because it never reads actual state.

**Cause — NOT established. Candidate hypotheses, in rough priority:**

- **H1 — omp doesn't load/connect agentmcp at spawn.** omp's log in
  the spawn dir had only 2 lines (model-discovery warnings), zero MCP
  connection lines. But config is correct on disk (fact 6). Needs:
  confirm whether omp actually opens the agentmcp HTTP connection.
- **H2 — the 50KB operator system prompt suppresses tool-calling.**
  The prior agent ran omp once with the *same spawn dir* but a
  *simple direct prompt and no `--system-prompt`*, and saw
  `toolcall_start: 1` / `tool_execution_end: 1`. **BUT the tool name
  was never confirmed** — it may have been a built-in, not an
  agentmcp tool. And that run differs from the real scenarios in
  several ways (single direct prompt vs. multi-turn sim-user; no
  system prompt; different prompt content). So H2 is a lead, not a
  finding. Do not treat "the system prompt is the cause" as settled.
- **H3 — omp's 250ms MCP startup timeout** (referenced in
  `chat-stream.ts` comments) expires before the HTTP MCP server
  responds, so tools register as `DeferredMCPTool` and the brain's
  `tools=[...]` parameter is empty for the turn. The code tries to
  mitigate by carrying over `agent.db`'s tool cache — verify that
  cache is actually populated (the live dir's `agent.db` had **no
  `mcp_tools` table**, which may mean the mitigation isn't working).

**Recommended next diagnostic (decisive):** run omp directly with the
spawn-dir setup AND the real 50KB operator `system.md` AND a prompt
that demands a tool call, capture full `--mode json` output, and parse
the `toolcall_*` events for the **tool name**. If an agentmcp tool
fires → H2/H3 about prompt/timing. If nothing fires → H1. Either way,
confirm the tool *name*, which the prior agent failed to do.

## Unknown / not done

- **M6–M12 re-run results never inspected.** Query
  `harness_shared.llm_test_runs` for `scenario_id LIKE 'op-M%'` rows
  with `started_at` ~13:17–13:20 to see whether they produced real
  runs or errored. The 7 `exit=1` codes alone don't distinguish
  "ran and failed an assert" from "SUT-health errored".
- **No final triage table** — P5's gate ("all failures classified as
  framework / scenario / operator bug, no untriaged red") is not met.
- The operator no-tool-call root cause is not fixed.

## Commits — VERIFY, don't trust

Prior sessions referenced commits `ae417737` (HOME-isolation +
system-prompt split in `chat-stream.ts` / `converse.ts`), `1083bfaf`,
`75215108` (framework retarget to `:3070`), `d92ef9ab` (plan doc).
**The next agent must run `git log` + `git status` to confirm what is
actually committed vs. working-tree.** In particular the agentmcp
stdio→HTTP switch in `converse.ts` may or may not be committed.

## Environment notes for the next agent

- Operator brain backend: omp → claude-bridge → Claude Max OAuth.
  **Subject to session limits** (resets on a rolling schedule). A
  whole batch can silently degrade to empty-output mid-run. Run
  batches when budget is fresh; expect `sut_no_output` `meta`
  findings if you hit the wall — those are not operator bugs.
- PG access: `PGPASSWORD=harness_admin_pwd psql -h 127.0.0.1
  -U harness_admin -d papercusp`. Table:
  `harness_shared.llm_test_runs`. Columns of note: `status`,
  `cost_usd`, `cap_breaches`, `scores_json`, `asserts_json`,
  `judge_json`, `findings_count` (no `verdict` / `total_turns`
  columns — those don't exist).
- `:3070` host is `bin/hono-host.ts`, systemd-user-managed
  (`papercup-dev.service`). It auto-restarts; don't hand-launch it.
- The 12 scenarios: `op-M1`…`op-M12` under
  `apps/operator/lib/llm-testing/scenarios/operator/`.
- CLI: `npx tsx bin/llm-test.ts --scenario op-M1-... --no-matrix`
  from `apps/operator/`. No prefix filter — batch via a shell loop.
- Leftover diagnostic files in `/tmp` (safe to delete):
  `/tmp/mcp-diag/`, `/tmp/mcp-diag-out.json`, `/tmp/mcp-diag-err.txt`,
  `/tmp/inspect.py`, `/tmp/p5-loop.log`, `/tmp/p5-rerun.log`,
  `/tmp/p5-batch.sh`.

## Suggested order of work for the next agent

1. `git log --oneline -15` + `git status` — establish ground truth.
2. Query PG for the ~13:17 M6–M12 rows — get the real re-run outcome.
3. Run the decisive omp diagnostic above — confirm H1 vs H2/H3 and
   the actual tool name. Do not skip the name confirmation.
4. Fix the operator no-tool-call defect (depends on which H).
5. Re-run all 12 `op-M*` once the operator actually calls tools.
6. Build the final triage table; close P5 in
   `operator-behavior-tests-2026-05-14.md`.

---

# Session 2 update — 2026-05-21 (evening)

Root-caused the operator no-tool-call defect to **five distinct bugs**.
Four are fixed + committed; the fifth is characterized but needs a
deliberate fix decision. Instruments: a logging MCP proxy
(`/tmp/mcp-proxy.mjs`, :3071), a logging model-API proxy
(`/tmp/model-proxy.mjs`, :3462 -> Meridian :3456), and ~11 isolated
`omp` diagnostic runs (`/tmp/diag-omp*`).

## Bug #1 — omp never loaded mcp.json — FIXED (papercup-shared 5f9a8d5)

chat-stream.ts (omp branch) set `HOME` and the spawn `cwd` both to
`ompAgentDir`. omp, started in a dir equal to `~`, auto-switches cwd to
a throwaway temp dir, defeating its `$cwd/mcp.json` scan -> agentmcp
never connected -> brain had zero MCP tools. Fix: pass `--allow-home`.
Proxy-verified.

## Bug #2 — every MCP tool described "Tool <name>" — FIXED (8b59f991)

`deriveDescriptionFromCallSite()` in packages/agent-mcp/src/define-tool.ts
was a stub returning null; tools with no explicit description projected
to MCP tools/list as the placeholder `Tool <name>`. The model-API proxy
confirmed the brain received all 228 agentmcp tools, every description a
placeholder. Fix: compose the description from `guidance`. Verified
live: 0/195 placeholders.

## Bug #4a — brain cold-spawned the engineer's MCP fleet — FIXED (papercup-shared 92b05b4)

Once --allow-home made mcp.json load, omp connected to the MERGED set —
chat-stream merged `agentmcp` with the engineer's personal
~/.omp/agent/mcp.json (voice-mode, hindsight, plur, playwright — stdio).
Fix: write mcp.json with ONLY the caller's servers.

## Bug #4 — discovery mode hung omp -> operator:converse 600s timeout — FIXED (papercup-shared 92b05b4)

With the user's global tools.discoveryMode=mcp-only, omp for a brain
spawn did not exit after the turn. Controlled diag: discovery-on omp
exit=124, discovery-off exit=0, all else identical. Fix: per-spawn
config.yml sets tools.discoveryMode=off / mcp.discoveryMode=false.
VERIFIED: op-M3 went from a 600s timeout to a 141s completion ($0.16).

## Bug #3 — tool-call event name strip mismatch — NOT FIXED

converse.ts:254 strips `mcp__agentmcp__` (double underscore); omp emits
`mcp__agentmcp_<verb>` (single). The `tool_called` assert misses even on
a real call. Fix drafted (reverse map from ALL_AGENT_MCP_TOOLS); apply
alongside the bug #5 fix.

## Bug #5 — operator confabulates via WaitForMcpServers — OPEN

Even with #1/#2/#4 fixed the brain calls ZERO real agentmcp tools.
op-M3 transcript (run 26a06291): one tool call —
`WaitForMcpServers({servers:["papercusp-su"]})` — omp rejects it ("not
found"); telemetry records 0 tool invocations. The brain then emits a
detailed FABRICATED harness report (F-FMT-002 EISDIR, stale runs
F-015/F-FIX-024/..., escalation 2026-05-14) claiming "I went through the
HTTP endpoint on :3070".

Verified: the model receives all 228 well-described agentmcp tools in
its API request (model-proxy) and does not call them. It waits for a
server named `papercusp-su` — but chat-stream names the operator's MCP
server `agentmcp`. NAME MISMATCH.

Hypotheses: (a) the brain learns `papercusp-su` + colon tool names from
the operator persona and/or the agentmcp server's injected
`## MCP Server Instructions` (which look like the engineer-collaborator
papercusp-su playbook — wrong audience); (b) the confabulation's real
feature IDs leak from the engineer's omp memories — chat-stream copies
the whole agent.db and `memories: enabled: true` injects them.

Recommended (plan-first decision):
1. Resolve the name mismatch — rename the operator's MCP server
   `agentmcp` -> `papercusp-su` in converse.ts, OR make the persona +
   tool catalog use the real `agentmcp` / `mcp__agentmcp_*` names.
2. Stop the agent.db memory leak — don't copy agent.db (the tool-cache
   rationale is void: no `mcp_tools:agentmcp` row exists), or set
   `memories: enabled: false` per-spawn.
3. Add an explicit persona line: MCP tools are already connected, never
   call WaitForMcpServers; confirm whether Meridian injects Agent-SDK
   tools.

## P5 state

4 of 5 root causes fixed + committed; the operator went from
timeout/total-confabulation to completing turns in ~141s. The 12-op-M
re-run + triage gate is NOT met — blocked on bug #5; re-running the
suite is pointless until the operator calls real tools.

# Session 3 update — 2026-05-21 (late)

The Session-2 bug-#5 hypotheses (name mismatch, agent.db memory leak)
were WRONG. Disproved with a logging model-API proxy that captures the
exact system+messages+tools omp sends the model:
- `papercusp-su` is absent from the model's actual API request
  (system=false, messages=false, tools=false). Not a leak.
- agentmcp's `initialize` returns no `instructions`; tool defs are clean
  (0/228 contain `papercusp-su`); `memories.enabled=false` already set.

## Bug #5 real root cause (part 1) — FIXED + committed (papercup-shared e0ee131)

`chat-stream.ts` passed omp `--system-prompt @/tmp/.../system.md`. omp's
`--system-prompt` takes a BARE FILE PATH — it does NOT support the
`@file` syntax (that is only for the positional message arg, processed
by a different code path). omp's `resolvePromptInput()` does
`Bun.file(value).text()` directly; the leading `@` makes the path
nonexistent, the ENOENT is silently swallowed, and omp falls back to
using the literal string `@/tmp/.../system.md` as the system prompt.

Consequence: the 44 KB operator persona NEVER reached the model. Worse —
a non-empty `--system-prompt` value switches omp to its minimal
custom-prompt template, which ALSO drops omp's own ~28 KB default
coding-agent prompt. The brain ran with a ~1.4 KB junk system prompt
(`@/path` + omp's PROJECT block) — near-totally ungrounded. Verified at
the wire: model-proxy `systemChars=1370` with the `@`, `45704`+ without.

An ungrounded `claude-opus-4-7` at MCP-session start does the Claude
Code reflex: call `WaitForMcpServers`. That is the entire origin of the
`WaitForMcpServers({servers:[...]})` "hallucination" — it was never a
hallucination, it was a real Claude-Code built-in being reached for by
a brain stripped of its omp grounding.

Fix (`e0ee131`): `--append-system-prompt <bare path>` instead of
`--system-prompt @<path>`. `--append-system-prompt` keeps omp's full
default prompt (grounding) and layers the persona after it. Verified:
persona delivered (systemChars 1370 -> 73330) and **0 `WaitForMcpServers`
in every post-fix discovery-off run**. The symptom the user flagged is
gone.

## Bug #5 remaining (part 2) — OPEN, not a setup bug I could isolate

Even with the persona delivered and `WaitForMcpServers` eliminated, the
brain still calls **0 real `mcp__agentmcp__*` tools**. It either runs
away thinking (8–32 thinking blocks, no output, 220 s timeout) or emits
confabulated text. Tested and ruled OUT as the cause, each with
evidence:
- discovery mode on/off (off is better — on brings `WaitForMcpServers`
  back, 31x; neither produces real tool calls)
- a clean workspace cwd separate from the omp agent dir
- `--thinking low`
- the `_i` schema parameter (it is universal omp behaviour — builtin
  `read`/`bash` carry it too and work fine; red herring)
- the model-proxy itself (no-proxy diag reproduces it)
- mem0 (pgvector absent -> volatile in-process store, empty on the
  first turn after every host restart; cannot be the origin)
- tool descriptions (fixed separately in bug #2; 0/228 placeholders now)

Remaining behaviour: a `claude-opus-4-7` brain that receives a
well-formed 244-tool surface plus the full operator persona, and
reasons itself out of calling any tool. In one run it stated its own
(false) belief verbatim: *"OMP has `mcp.discoveryMode: false`, so the
agentmcp tools aren't registered as functions"* — then proposed
"curl-dispatching" instead. The tools ARE in its API `tools` array
(228, verified). On current evidence this is a model-behaviour failure
in omp `-p` single-shot mode with this large composite prompt, not a
config bug with a one-line fix. Needs a fresh session and likely an
omp-side or persona-side change (a grounding line that the MCP tools
are connected and directly callable), or a different invocation mode.

## Diagnostic instruments left on disk (throwaway — delete after triage)
- `/tmp/model-proxy.mjs` — logging model-API proxy (:3462 -> Meridian
  :3456); dumps full request bodies to `/tmp/model-proxy-req-*.json`.
- `/tmp/diag-p5*.sh`, `/tmp/diag-cwd.sh`, `/tmp/diag-disco.sh` —
  replicated operator-brain spawns.
- `apps/operator/scripts/_dump-operator-prompt.ts` — dumps the real
  assembled operator system+user prompt.
