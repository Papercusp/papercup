# Code-execution tool-orchestration — REMAINING work + parallel SU briefs (2026-06-20)

**Operating model:** the owner is parallelizing the remaining code-execution-plan work across SU
agents. I (role-1176, stand-in manager) wrote these briefs; **handoff is GATED on the owner's
explicit greenlight** (do NOT dispatch yet). After greenlight I hand off via coord, arm a 2-min
monitoring loop, and wake/message the fleet to drive the plan to completion.

**Hard gates (apply to all build/ship):** the fleet **deploy-freeze + git-sync stall** is still
active — work builds + tests green LOCALLY (kopia-backed) but won't commit/ship until that clears.
The token tracking (**B-TOK**) is also stranded, so measurement-targeted items derive targets from
`dev_telemetry` / `agent_usage_samples` directly until B-TOK lands.

---

## DONE this session (green locally; do NOT redo)
- **B-CX-PRE** ✅ — `effect:'read'|'write'` on every tool def (inferred from capability suffix +
  a central known-mutator set; threaded onto `ProjectedTool`). Full tooldef suite **404/404** incl.
  5 effect tests. Files: `libs/generic/tooldef/src/{types.ts,define-tool.ts,tool-projection.ts,effect-inference.test.ts}`.
- **B-CX-1A** ✅ — code-mode runtime in `libs/generic/tooldef/src/code-orchestration/`: `tool-facade.ts`
  (registry→`tools.ns.verb()`, whitelist-scoped), `run-script.ts` (node:vm executor, returns only the
  summary), `parse-check.ts` (regex disallowed-ref fast-fail), `dispatch-binding.ts` (`realDispatch`
  routes through the real dispatcher + unwraps ToolResult). **19 tests**.
- **B-CX-2A** ✅ — `orchestrate.ts` (parse-check → facade over realDispatch + **dryRun/confirm gate**
  on `effect:'write'` → run) **4 e2e** (real dispatcher); `code:run` defineTool registered + verified
  (write-effect, SU-gated). Files: `…/code-orchestration/orchestrate.ts`, `packages/operator-core/lib/agent-tools/code/run.ts`.

---

## REMAINING plan items → 8 parallel briefs

### B-CX-API — code-mode tool API surface (signatures + on-demand catalog)  [independent · HIGH value]
**Why:** the model can already name tools from the normal catalog, but explicit typed signatures cut
script errors AND enable the Anthropic "on-demand tool discovery" token win (don't dump all ~70 tool
defs into every prompt). **Scope:** codegen `tools.<ns>.<verb>(args): Promise<…>` TS signatures from
the registry (zod→TS via the existing `toJsonSchema`), scoped to the agent's allowed set; expose them
via code:run guidance and/or a `code:tools` lookup tool for on-demand loading. **Files:** new
`…/code-orchestration/facade-types.ts` (+ test); wire into `code/run.ts` guidance. **Done:** signatures
generated for a sample set, types match the arg schemas, a test asserts it; on-demand path documented.

### B-CX-DEPS — thread the real dispatch deps into code:run  [needs host-deps study · HIGH/safety]
**Why:** MVP `code:run` passes `deps:{}`, so inner tool calls get role-allowlist gating but NOT the
host capability-ENVELOPE port and NO `recordInvocation` telemetry (inner calls are invisible to spend
tracking). **Scope:** construct/thread the host's real `DispatchProjectedDeps` (envelope port +
telemetry) for inner calls — model on `tooldef-mcp/src/index.ts` + `events/dispatch-reaction.ts` (the
in-process re-dispatch pattern). **Files:** `code/run.ts`, possibly a small host-deps accessor. **Done:**
test shows an inner call is `recordInvocation`-logged AND an envelope-denied tool throws inside a script.

### B-CX-SANDBOX — hardened isolated executor  [independent · MED-HIGH/safety]
**Why:** `run-script.ts` uses node:vm — not a security boundary, and a *synchronous* infinite loop
blocks the host (the wall-clock race only bounds async work). **Scope:** swap the executor internals
for a worker-thread (or subprocess) runner: true isolation, interruptible/killable on timeout incl.
sync loops, optional mem/cpu bounds. Keep `runOrchestrationScript`'s surface unchanged. **Files:**
`…/code-orchestration/run-script.ts` (+ a worker entry) + test. **Done:** a `while(true){}` script is
killed at the timeout; existing run-script tests still green.

### B-CX-EFFECT — effect-marker correctness audit + backfill  [independent · HIGH/gate-correctness]
**Why:** the dryRun gate's safety is only as good as the `effect` marking. The B-CX-PRE heuristic
(`:write/:admin/:delete/:manage/:execute` + a small set) MISSES mutators with other capability shapes.
**Scope:** audit all ~71 agent-tool capabilities + tools; set explicit `effect:'write'` (or extend the
central set) for every mutator the heuristic misclassifies as read — candidates: `fleet:spawn`,
`hive:wake`/`hive:*` mutations, `operator:delegate`, `plans:*` writes, `deploy:*`, `send_message`,
`tui:dispatch`/`ui:dispatch`, `turn:interrupt`, etc. **Files:** the offending tool defs +
`define-tool.ts` WRITE_CAPABILITIES + a test asserting key mutators are `'write'`. **Done:** a test
enumerates known mutators and asserts none infer `'read'`.

### B-CX-PARSE — AST-based parse-check  [independent · MED/robustness]
**Why:** the regex parse-check misses computed/aliased access (`tools['sys']['admin']`, destructuring).
**Scope:** replace with a TS-compiler-API AST walk that resolves `tools.*` member/`call()` references
robustly and validates against the allowed set; keep `checkScript`'s surface + result shape. **Files:**
`…/code-orchestration/parse-check.ts` + test (computed access flagged). **Done:** new tests for computed/
aliased forms pass; the runtime whitelist remains the boundary (parse-check stays a fast-fail aid).

### B-CX-1B — compound tools for the top measured hotspots  [dep: measurement · MED/perf]
**Why:** the cheap/safe complement to code:run — for the 2-3 hottest multi-step flows, a server-side
compound `defineTool` (composes existing handlers via `dispatchProjectedTool`, returns a summary)
beats both round-trips and a script. **Scope:** from `dev_telemetry`/`agent_usage_samples` (or B-TOK
when live), pick the top 2-3 round-trip-heavy flows; build a compound tool for each. **Files:** new
tools under `agent-tools/<group>/` + tests. **Done:** 2-3 compound tools green, each with a documented
before/after round-trip count.

### B-CX-3 — prompts + exemplar conversion + measured before/after  [dep: B-CX-API + measurement · MED/rollout]
**Why:** the feature only pays off once agents KNOW to use it. **Scope:** add when-to-use-code:run
guidance to the su/bee/operator prompts (code:run vs direct; "summarize conservatively — over-filtering
backfires", per the plan §8); convert 1-2 measured hot flows into code:run exemplars; measure the
inference-call + token before/after. **Files:** the persona/prompt files + an exemplar + a measurement
note. **Done:** guidance merged, 1-2 exemplars run, a real before/after number recorded.

### B-CX-SHIP — full-repo green + measurement instrumentation + deploy-gated live verify  [GATED]
**Why:** the per-package suites are green, but a repo-wide build + a live-agent e2e are the real ship
gate. **Scope:** (a) instrument code:run savings (round-trips collapsed, token before/after, inner-call
attribution — ties to B-TOK); (b) verify the whole change builds green repo-wide + commits via git-sync;
(c) once the deploy-freeze clears, run code:run in a live agent session end-to-end. **Files:** an
instrumentation hook + a CI/build verification + a live-session test note. **Done:** repo-wide green,
committed, and one live code:run round-trip demonstrated post-deploy-clear. **Gated on the deploy-freeze.**

---

## Parallelism / sequencing (for the waker)
- **Run-now-parallel (independent, no cross-deps):** B-CX-API, B-CX-DEPS, B-CX-SANDBOX, B-CX-EFFECT, B-CX-PARSE.
- **Measurement-gated:** B-CX-1B, B-CX-3 (derive targets from dev_telemetry if B-TOK isn't live).
- **Ship-gated (deploy-freeze):** B-CX-SHIP (do prep now; live verify after the freeze clears).
- **Shared-file caution (git-sync stalled → degraded merge):** B-CX-API/DEPS/PARSE touch
  `code-orchestration/*` + `code/run.ts`; B-CX-EFFECT touches `define-tool.ts`. Serialize edits to the
  same file via coord locks; the waker assigns to avoid two agents in one file.
- **Owners:** TBD — assign live at handoff (the loop-off stranded the prior su roster).
