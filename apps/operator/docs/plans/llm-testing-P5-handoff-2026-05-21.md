---
title: Llm Testing P5 Handoff
slug: llm-testing-P5-handoff-2026-05-21
created: 2026-05-21
updated: 2026-05-30
status: ready
---

## Now

**State:** P5 live-triage handoff

**Next:** P5 live-triage handoff

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

# Session 3 continued — bug #5 RESOLVED (the real root cause)

The "part 2" above (brain calls 0 tools) is now SOLVED. The cause was
**Meridian context contamination via a shared `x-meridian-agent`.**

## Root cause

The operator brain's omp spawn copies the engineer's `models.json` /
`models.yml`, which set `providers.anthropic.headers.x-meridian-agent:
pi`. `pi` is the SHARED omp identity every omp process on the box uses.
Meridian keys its per-agent context — system prompt, tool set, prompt
cache — by that header. So every `pi` request is folded into ONE shared
context, dominated by whatever `pi` agent is live (here: the engineer's
Claude Code session).

A brain spawn inheriting `x-meridian-agent: pi` had its request's
`system` + `tools` effectively OVERRIDDEN by that shared context. The
model never received its 228 agentmcp tools — it received the live
Claude Code session's toolset — so it correctly reported "no such tool"
and confabulated. It was never a model-behaviour bug; the brain was
handed the wrong context.

Why the engineer's other omp agents are fine: they all expect the same
shared fleet (playwright/context7/voicemode/…), so context-sharing is
harmless for them. Only a brain that uniquely needs `agentmcp` breaks.

## Proof (direct Meridian probe)

Identical one-tool request to Meridian `:3456`, varying only the header:
- `x-meridian-agent: pi` → ignores the request's `tools`, replies with
  the foreign session's toolset (`input_tokens` inflated, `cache_read`
  ~10 K — foreign context injected).
- `x-meridian-agent: <fresh unique>` → `tool_use` the sent tool. ✅
- no header → `tool_use` the sent tool. ✅

## Fix — committed (papercup-shared 8b4cda7, superproject ff5728d3)

`chat-stream.ts`: after copying `models.json`/`models.yml` into the
spawn dir, rewrite every `providers.*.headers.x-meridian-agent` to a
per-spawn-unique value `papercup-brain-<spawn-dir-basename>`. Per-spawn
(not per-role) so concurrent brain spawns never cross-contaminate.

## Verified end-to-end

Replicated the exact fixed operator spawn (real persona, agentmcp,
discovery off, `--append-system-prompt`, unique x-meridian-agent):
omp `exit=0`, brain called **real** `mcp__agentmcp_harness_list` /
`issues_list` / `operator_last_scan`, **0 WaitForMcpServers**, and gave
an honest grounded answer off real tool results (it even surfaced a
real downstream handler error rather than confabulating).

## bug #5 — three layered root causes, all now fixed

1. `--system-prompt @path` → persona never loaded — fixed (`e0ee131`).
2. `--system-prompt` replace-mode drops omp grounding → WaitForMcpServers
   reflex — fixed by `--append-system-prompt` (`e0ee131`).
3. shared `x-meridian-agent: pi` → Meridian context contamination →
   agentmcp tools overridden → 0 tool calls — fixed (`8b4cda7`).

## Known follow-up (separate from P5)

The verification run's `harness:list` and `issues:list` agentmcp calls
returned a real handler error ("undefined reading `parsers`"). The
brain handled it gracefully (reported it honestly). That is a genuine
agentmcp handler bug, separate from bug #5 — file it on its own.

## P5 next steps

Restart the host so the fix loads, then re-run the 12 op-M scenarios.
The brain now calls real tools, so the suite gate can finally be
evaluated (modulo the harness:list/issues:list handler bug above).

## Follow-up bug, precisely characterized — harness:list / issues:list crash

Separate from P5 bug #5 (which is fixed). Every agent-mcp tool whose
handler does `drizzle(ctx.tx)` currently crashes:

  handler_error: Cannot read properties of undefined (reading 'parsers')

Trace:
- `harness:list` (packages/agent-mcp/src/tools/harness/list.ts) does
  `const txDb = drizzle(ctx.tx)` — drizzle-orm/postgres-js.
- `ctx.tx` is set by `resolvePrincipalAndTx` in
  `apps/operator/lib/endpoint-route/routes/agent-tools/catchall.ts`,
  which returns `tx: getOrgPg().sql`.
- `drizzle(client)` reads `client.options.parsers`; the crash means
  `getOrgPg().sql.options` is `undefined` — the value is truthy (passes
  define-tool.ts:344's `!ctx.tx` guard) but is not a postgres-js `Sql`
  client with the expected `.options`.

Likely a drizzle-orm or postgres-js version bump, or a change to what
`getOrgPg()` (@restart/db-org) exposes as `.sql`. Affects ALL superuser
MCP `harness:*` / `issues:*` calls (reproduced with a direct curl, not
operator-specific). NOT fixed here — it is its own regression in the
agent-mcp ↔ drizzle integration and needs a focused fix (verify
drizzle-orm/postgres versions, confirm getOrgPg().sql shape, or have
the handlers consume a ready drizzle instance instead of building one
from ctx.tx). Until it is fixed the op-M suite cannot fully pass even
though the operator brain now calls tools correctly.

# Session 3 continued — the harness:list "parsers" regression RESOLVED

The follow-up bug above is fixed.

## Root cause

`withWorkspace(workspaceId, fn)` (libs/papercusp/libs/db/src/
workspace-context.ts) runs `fn` inside `sql.begin(async (tx) => …)`.
postgres-js's `tx` is a **`TransactionSql` — a subset of `Sql` that
omits `.options`** (the parsers/serializers config). drizzle-orm
0.45.2's `drizzle(client)` constructor does
`client.options.parsers[type] = …`, so every `drizzle(tx)` inside a
withWorkspace callback threw `Cannot read properties of undefined
(reading 'parsers')`. That broke `harness:list`, `harness:status`/
`get`, the tasks/features/goals/messages read tools, and the operator
scan-lock — i.e. all 10 `drizzle(ctx.tx)` agent-mcp tools. (A bare-
client `drizzle(getOrgPg().sql)` works fine — the raw `Sql` has
`.options`; only the transaction subset doesn't.)

## Fix — committed (papercusp 0418c70, superproject 593c74d9)

In `withWorkspace`, point the TransactionSql at the parent connection's
`.options` (`txSql.options ??= sql.options`). parsers/serializers are
connection-scoped, so this is correct; it's a no-op for raw `tx`...``
queries (getOrgPgApp() already drizzle-mutated the parent's parsers).
One fix at the withWorkspace chokepoint covers every `drizzle(tx)`
callsite.

## Verified

`harness:list` → 5 real harnesses, `harness:status` → real data, no
`handler_error`. Reproduced and fixed with an isolated probe:
`drizzle(tx)` FAIL → `drizzle(tx + parent.options)` OK.

## P5 status

Both blockers cleared: the operator brain calls real tools (bug #5
Meridian fix) AND those tools now return real data (this fix). P5's
12 op-M scenarios can now be run for real.

# Session 3 final — P5 code blockers cleared; suite run env-blocked

## All P5 code work done + committed

| Fix | Commit |
|---|---|
| bug #5a — omp `--system-prompt @path` → persona never loaded | papercup-shared `e0ee131` |
| bug #5b — `--system-prompt` replace-mode → grounding loss → WaitForMcpServers reflex; → `--append-system-prompt` | papercup-shared `e0ee131` |
| bug #5c (core) — Meridian shared `x-meridian-agent: pi` context contamination → per-spawn-unique agent id | papercup-shared `8b4cda7` |
| `parsers` regression — `drizzle(withWorkspace tx)` crash; tx lacks `.options` → shim in `withWorkspace` | papercusp `0418c70` |
| llm-testing — patient transient-error retry (529/429/5xx) in `llmCall` | `0d8b74bb` |

Superproject pointer bumps: `ff5728d3`, `593c74d9`. Handoff-doc commits:
`f0ad2a67`, `e5edbac1`, `709aae59`, `e8d0b37e`.

## Verified

- Operator brain E2E (diag, both fixes live): calls real
  `mcp__agentmcp_*` tools (harness:list/status/pending_reviews,
  issues:list, audit:list, chat:ask_choice), 0 WaitForMcpServers, 0
  `parsers` errors, produces a real grounded answer.
- `harness:list` / `harness:status` return real data via direct curl.
- The 529-retry: confirmed firing in a live op-M3 run log —
  `transient API error (attempt 1/5)… (attempt 2/5), retrying`.

## Why the op-M suite was not run to completion

Not a code defect. The Anthropic API was in a sustained `529
Overloaded` state for the whole session window; op-M3 was attempted
5×, each defeated by either a 529 storm (now retried, but the overload
outlasted the retry budget on the worst runs) or the test harness /
process being killed mid-run by environment instability. The two P5
blockers are fixed and verified; the suite simply needs to be run once
Anthropic capacity recovers. With `0d8b74bb` in place the runner now
rides out transient 529s on its own.

## Next step (clean, when the API is healthy)

`cd apps/operator && npx tsx bin/llm-test.ts --scenario op-M<N>-… --no-matrix`
for each of the 12 op-M scenarios (or loop them). Results persist to
`harness_shared.llm_test_runs` (status / asserts_json / judge_json),
so a killed runner doesn't lose a completed run. Clear any stale
`harness_shared.llm_test_claims` row first if a prior run died holding
one.

## Final: full retry chain captured — API sustained-overloaded

A detached op-M3 run after the retry fix logged the complete chain:

```
attempt 1/5 retry 2.3s → 529 Overloaded
attempt 2/5 retry 4.2s → 529 Overloaded
attempt 3/5 retry 8.4s → 529 Overloaded
attempt 4/5 retry 16.0s → 529 Overloaded
✗ runner error: 529 Overloaded
```

5 outer retries × SDK's own retries ≈ 15 API hits over ~31s, all 529.
Same overload was aborting agent turns all session
("Anthropic stream stalled"). Retry mechanism verified correct; the
overload simply outlasts any reasonable per-run budget. No further
test-runner change would help right now — wait for capacity.


---

# Session 2 — 2026-05-22

Picked up after the prior session's overnight stop. Goal: stop wasting
spawn overhead on `runAgentChat` callers that don't need omp/claude-code
subprocess semantics (no MCP, no tools, no agent loop), and tighten
role→model resolution so llm-testing picks up workspace settings.

## Shipped

| Change | Commit |
|---|---|
| `runAgentChat` gains `'meridian'` backend — stateless HTTP via Anthropic SDK to `:3456`, OAuth token from `~/.omp/agent/auth.json`, per-call `x-meridian-agent`, 8-attempt 529 retry up to 60s. | papercup-shared `016732b` |
| Superproject pointer bump for meridian backend. | `1deb3f0f` |
| `llm-testing/llm-client.ts` routed through `runAgentChat({backend:'meridian'})` — single hardened path, no parallel Anthropic SDK plumbing. | `8fed80b0` |
| `apps/operator/lib/haiku.ts` migrated to meridian (background summariser; no MCP, no tools). 5s→15s timeout to absorb cold-cache first call (~6-7s) + one 529 retry. | `82410c91` |
| `endpoint-route/routes/agent-config/test.ts` migrated to meridian (`/settings/agent` "Test current backend" button). Behavioral shift flagged in docstring: now probes the Meridian path, not the omp/claude-code subprocess CLI. | `82410c91` |
| `llm-testing/runner.ts` — judge + sim-user defaults consult operator agent-config `models['llm-testing-judge']` / `models['llm-testing-sim-user']` between explicit-args and registry/hardcoded fallback. `LLM_TEST_JUDGE_MODEL` / `LLM_TEST_SIM_MODEL` env still win. | `22323a07` |

## runAgentChat caller audit — decisions logged

Reviewed every real caller of `runAgentChat` for "is the omp subprocess
spawn earning its keep, or is this a pure ping/summary."

**Stays on omp** (legitimately needs the agent loop / MCP):
`operator/converse.ts` (brain), `operator/scan.ts`, `operator/delegate.ts`,
`oracle/chat.ts`, `plans/runner.ts`.

**Now on meridian** (shipped this session):
`llm-testing/llm-client.ts`, `lib/haiku.ts`, `agent-config/test.ts`.

**Explicitly stays on omp by user decision** (2026-05-22):
`architect/chat.ts` and `agent_chats/chat.ts`. Both pass `cwd` and
would inherit omp's default builtin toolset; user chose not to migrate
without a `harness_shared.tool_invocations` audit confirming they're
text-only in practice.

## Why op-M was not run this session

Same pattern as session 1 — different proximate blocker:

- The embedded Postgres on `:16534` was not running this session
  (`~/.papercusp/embedded-pg.json` absent → desktop app not started).
  The llm-testing framework writes results to
  `harness_shared.llm_test_runs`; without PG the run can't persist.
- Anthropic was stalling tool calls intermittently (six consecutive
  `Anthropic stream stalled while waiting for the next event` errors
  on one task), suggesting the same 529-class capacity issue that
  blocked session 1 is still ongoing — though now the runner's retry
  loop lives in the meridian backend (`RETRY_MAX = 8`, `RETRY_CAP_MS
  = 60_000`) rather than in `llm-client.ts`, so longer overloads can
  be absorbed.

## Next step (still)

Bring up the desktop app (or otherwise start embedded PG on
`:16534`), wait for Anthropic capacity, then loop the op-M suite:

```
cd apps/operator
psql "$(cat ~/.papercusp/embedded-pg.json | jq -r .url)" \
  -c "DELETE FROM harness_shared.llm_test_claims;"
for s in op-M1 op-M2 op-M3 op-M4 op-M5 op-M6 op-M7 op-M8 op-M9 op-M10 op-M11 op-M12; do
  npx tsx bin/llm-test.ts --scenario "$s" --no-matrix || true
done
```

With the meridian retry chain plus the role→model defaults from
agent-config, the runner should ride through transient 529s and pick
up whatever judge/sim-user model the user has set in `/settings/agent`
without code changes.

## Notes from the audit that are NOT actionable now

- `MERIDIAN_PRICES` (in `libs/papercup-shared/src/agent/chat-stream.ts`)
  is the canonical pricing table for the meridian backend. The
  `MODEL_PRICES` table in `llm-client.ts` is **redundant** now that
  the meridian backend returns `costUsd` in the `result` event;
  callers can stop re-computing. Removing the duplicate is a tidy-up
  pass, not a behavior fix.
- The "Test current backend" button on `/settings/agent` no longer
  validates the omp/claude-code subprocess CLI — only Meridian + auth.
  If a future user reports "I picked claude-code in settings but the
  button says PASS", the fix is to split this into two buttons
  ("Test Meridian path" / "Test subprocess CLI"). Not done now.

---

# Path B attempt — operator brain on an OpenAI model (2026-05-22)

Goal: run the op-M suite with the SUT (operator brain) on an OpenAI
model, to side-step the Anthropic 529 storm. The brain model was made
configurable first (commit `74ca81ff` — `OPERATOR_BRAIN_MODEL` env >
agent-config `models['operator']` > pinned Anthropic default).

**Outcome: blocked.** The brain leg of Path B cannot run on OpenAI in
this environment. Judge + sim-user on OpenAI is fine (they use the
meridian backend); the *brain* is the problem.

## Why the brain can't go on OpenAI

The brain MUST use the **omp backend** — it needs the agentmcp MCP
tools, and the `meridian` backend explicitly rejects `mcpConfig`. omp
has exactly two OpenAI routes, both dead here:

| Route | Path | Result |
|---|---|---|
| `openai-codex/<model>` | omp Codex provider → ChatGPT Codex backend (`wss://chatgpt.com/backend-api/codex/responses`, or HTTPS with `providers.openaiWebsockets: off`) | omp exits 0 with **empty output**. `~/.omp/agent/auth.json` holds only an `anthropic` token — there is no Codex/ChatGPT credential, so the provider produces nothing (silently) on both transports. |
| `openai/<model>` | omp `openai` provider → Meridian (`:3456`) | omp exits 0 empty. omp's `openai` provider uses the **OpenAI Responses API** (`POST /v1/responses`) for gpt-5; Meridian returns `404 "Endpoint not supported: POST /v1/responses"`. |

Meridian (`:3456`) **does** route OpenAI models — but only on the two
endpoints it implements: `/v1/messages` (Anthropic wire format) and
`/v1/chat/completions` (OpenAI Chat Completions). Both translate
`gpt-5` / `gpt-5.5` correctly (verified by direct curl). The gap is
purely `/v1/responses`, which omp's openai provider insists on for
gpt-class reasoning models and Meridian doesn't expose.

A model alias in `~/.omp/agent/models.json`'s `models:` block does
NOT help — that block is not omp's model-registration mechanism
(the pre-existing `claude-sonnet-local` / `claude-opus-local` aliases
there also fail to resolve; omp resolves models from its own catalog
+ `models.db`, fuzzy-matched).

## What WOULD unblock it

One of:
1. **Authenticate omp's Codex provider** — a user action (`codex
   login` / interactive ChatGPT login through omp). Then
   `openai-codex/<model>` works and `models['operator']` can point at
   it via /settings/agent.
2. **Meridian gains `/v1/responses`** — then `openai/<model>` through
   omp's openai provider works. (Meridian is the oh-my-pi router, not
   papercusp code — not ours to patch.)
3. **omp gains a way to force its openai provider onto
   `/v1/chat/completions`** — Meridian already serves that endpoint.
   No such toggle found (`providers.kimiApiFormat` exists for kimi;
   no general `openaiApiFormat`).

Until then, an op-M run on a fully-OpenAI stack is not possible; the
brain stays on Anthropic.

## Shipped regardless

`74ca81ff` — the operator brain model is now configurable like every
other agent role (env > agent-config `models['operator']` > pinned
`anthropic/claude-opus-4-7`). `operator` added to the /settings/agent
role hints. This stands on its own: once a working OpenAI route
exists, switching the brain is a one-field settings change.

## Probe notes (verified this session)

- `agent-config` write API + the converse.ts resolver round-trip:
  setting `models['operator']` → the brain picked it up on the next
  turn with no restart (resolver reads per-turn).
- The host (`papercup-dev-api.service`) resolves PG via
  `embedded-pg-discovery.ts` → native fallback
  `postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp`.
  `harness_shared.llm_test_*` tables are all present there. The
  earlier ":16534 down" note was a red herring — the host never used
  `:16534`; that was a stale desktop-embedded-PG assumption.
- `bin/llm-test.ts` must be run with cwd `apps/operator` (the `@/`
  path alias resolves from the local tsconfig; running from repo root
  fails with `Cannot find module '@/lib/embedded-pg-discovery'`).
