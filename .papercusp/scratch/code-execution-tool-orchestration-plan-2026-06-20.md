# Code-execution tool orchestration on our MCP tools — DETAILED PLAN (2026-06-20, for owner review)

## 1. Summary
Adopt the **"code execution with MCP"** pattern (Anthropic's blueprint; academic root = CodeAct):
present our MCP/agent tools as **callable TypeScript functions** in a sandboxed runtime, and let an
agent emit a **multi-step program** (loops/conditionals/retries + result filtering) that the runtime
executes — collapsing many model round-trips into ~one and keeping raw tool results OUT of the model's
context (only summaries return). This attacks our measured cost driver (calls × growing re-read
context). **The bet is scale-dependent**, so the build is gated on the token tracking (B-TOK) naming
the actual hotspots — and there is **one real architecture decision for you** (general runtime vs.
targeted compound tools, §4).

## 2. The problem (cost mechanics)
Agent cost ≈ (number of inference calls) × (the growing context re-read on each call, billed at
cache-read ~10%). Our agents run **30–50+ tool calls/session**; each tool round-trip is a separate
inference call that re-reads everything so far. Code-mode cuts BOTH terms: fewer calls (the loop runs
in the runtime) + smaller context (raw results stay in the runtime; only summaries re-enter). It's
also a quality win — model accuracy degrades as raw tool-output grows (arXiv:2510.15955).

## 3. Do the methods converge or compete?
**Convergent principle (settled):** Anthropic code-execution-with-MCP, CodeAct (arXiv:2402.01030),
smolagents, LLMCompiler (arXiv:2312.04511), ReWOO all agree — move orchestration + data-handling out
of the per-step model loop into a runtime; keep intermediate data out of context; collapse round-trips.

**Fork 1 — THE decision (general runtime A vs. compound tools B):** see §4. Competes on power-vs-risk;
the measurement decides.

**Fork 2 — resolved (imperative code, not declarative DAG):** imperative code (CodeAct/Anthropic)
subsumes the DAG planner's (LLMCompiler/ReWOO) parallelism via `Promise.all` while being more
expressive for data-dependent logic. Use code; borrow parallel-batching inside it; don't build a DAG
planner.

**Orthogonal (complementary / different layer, NOT competing):**
- Constrained decoding / structured output (Guidance, Outlines, LMQL, XGrammar): a *reliability* knob
  for valid emission — an optional later add-on, not a competing orchestration model.
- DSPy: a *developer-facing pipeline-authoring/optimization* framework — a different layer than
  runtime tool orchestration.
- Native parallel/batched tool calls: API-supported today (free); use now; subsumed by code's
  `Promise.all`.

## 4. THE decision for review — General runtime (A) vs. Compound tools (B) vs. Hybrid
| | **A — General code-execution runtime** | **B — Targeted compound tools** |
|---|---|---|
| What | Model writes arbitrary TS calling tools as functions; sandbox executes | Hand-built server-side tools that bundle a hot flow + return a summary |
| Power | General — any flow, any logic | Bespoke — only the flows you pre-build |
| Round-trip win | Yes, broadly | Yes, for the built flows |
| Summarization win | Yes (model decides what to keep) | Yes (tool decides) |
| **Safety** | **Hard — executing model-written code that calls mutating tools; no production sandbox exists in the literature** | **Easy — no model-written code; no new attack surface** |
| Build cost | High (runtime + sandbox + envelope wiring + parse checks) | Low per tool (a normal tool + server-side logic) |
| Best when | MANY diverse hotspots bespoke tools can't economically cover | A FEW concentrated, stable hotspots |

**Recommended default = Hybrid, sequenced, measurement-driven:**
1. Measure with B-TOK → rank the highest round-trip / worst-accumulation flows.
2. **Ship compound tools (B) for the top 2–3 hotspots first** — fast, safe, no sandbox, immediate
   measured savings.
3. **Build the general runtime (A) only if** the measurement shows *breadth* (many diverse hotspots) —
   i.e. only when bespoke tools stop being economical. A is the bigger, riskier bet; earn it with data.

This sidesteps the unsolved-sandbox problem for the common case and de-risks the whole initiative.
**Your call: accept "B-first, A-if-breadth," or pre-commit to A, or pre-commit to B-only.**

## 5. Decisions
- **D-001 — Language = TypeScript** (matches operator-core; tools already TS). NOT a custom DSL
  (models hallucinate DSL names, arXiv:2408.08335), NOT constrained plan-JSON (loses composability;
  constraints don't improve reasoning), NOT bash for orchestration (weak at structured data / typed
  tool-functions / sandboxing). Bash stays for file ops.
- **D-002 — Measure-first.** Build gated on B-TOK identifying real hotspots; the bet is scale-dependent.
- **D-003 — Safety (the engineered part):** isolated runtime; **reuse the capability envelope as the
  tool whitelist**; **dry-run/confirm on mutating tools**; **static AST parse-checks** (catch bad tool
  names pre-execution); **model escape-hatch** (on exception / judgment, return to the model).
- **D-004 — Selective adoption:** code-mode for multi-step/multi-tool/large-output flows; direct calls
  for single-step/judgment-heavy. Opt-in per flow.
- **D-005 — Imperative code, not a DAG planner** (§3 Fork 2).
- **D-006 — Architecture per §4** — default Hybrid (B-first, A-if-breadth); pending owner review.

## 6. Phases
- **Phase 0 — Measure + decide (gated on B-TOK):** rank hotspots; pick B-targets; decide whether
  breadth justifies A. Thin analysis on the token data; no new infra.
- **Phase 1B — Compound tools for the top hotspots:** build 2–3 server-side aggregating tools (multi-
  step + summarized return) for the measured hot flows. No sandbox. Measure savings vs the B-TOK
  baseline.
- **Phase 1A — General runtime (only if §4 warrants):** MCP-tools-as-typed-TS-functions API; sandboxed
  executor enforcing the capability-envelope whitelist; static parse checks; result capture.
- **Phase 2A — Agent surface + safety (paired with 1A):** submit-script verb; dry-run/confirm on
  mutating tools; escape-hatch.
- **Phase 3 — Rollout + prompts + measure:** prompt guidance (when code-mode vs direct; summarize
  conservatively — over-filtering backfires); convert exemplar flows; measure actual savings.

## 7. Briefs (su; ⚠ build gated on the rename window + B-TOK)
- **B-CX-0 — hotspot targeting + the A/B call** (thin, on B-TOK; manager or an su).
- **B-CX-1B — compound tools for the top 2–3 measured hotspots** (Phase 1B; the cheap/safe first win).
- **B-CX-1A — code runtime + MCP-tools-as-TS-functions + envelope whitelist + parse checks** (Phase 1A;
  only if §4 → A; study smolagents executor + Anthropic MCP-code as references).
- **B-CX-2A — submit-script surface + dry-run/confirm + escape-hatch** (Phase 2A; deps B-CX-1A).
- **B-CX-3 — prompt guidance + convert exemplars + measure savings** (Phase 3; deps the chosen path + B-TOK).

## 8. Risks / honest caveats
- **Sandbox security is unsolved in the literature** — model-written code calling mutating tools is a
  real surface (HF executor "not a security boundary"; NCC Group flagged insecure usage). This is why
  B-first de-risks: compound tools avoid it entirely.
- **Scale-dependent** — marginal at 3–4 tools; measure-first guards against over-building.
- **Model-capability dependent** — small/haiku models write buggy code; check before routing code-mode
  to haiku bees.
- **Not universal** — extractive single-shot tasks favor direct answers; keep code-mode opt-in.
- **Over-summarization backfires** — strip too much → re-calls (the "field-filtering accuracy gain"
  claim was *refuted* in research). Summarize conservatively.
- Headline prior-art numbers (98.7%, 6.7×, 20%) are best-case/vendor/single-benchmark maxima.

## 9. Open decisions for the owner (review)
1. **§4 architecture:** accept "Hybrid: B-first, A-if-breadth" (recommended), or pre-commit to A, or B-only?
2. **Trigger to build A:** what breadth threshold (e.g. "≥N distinct hotspot flows bespoke tools can't cover") flips us from B to A?
3. **Sandbox risk appetite:** how aggressive on mutating-tool dry-run/confirm gating (default: confirm-gate all mutations from model-written code initially)?
4. **Scope of code-mode rollout:** su agents + bees, or bees-only initially (haiku code-quality caveat)?

## 10. Sequencing / gating
Design = now (this doc). Build = gated on (a) rename window closing + (b) B-TOK landing + measuring
hotspots. Recommended order: B-TOK → Phase 0 (decide A/B) → Phase 1B (compound tools, fast safe win) →
Phase 1A/2A (general runtime) only if breadth warrants → Phase 3 (measure + roll out). Do NOT build
ahead of the measurement.

## 11. Code integration — how this lands in our `defineTool` system (grounded survey)
**Make-or-break verdict: GREEN.** Our tool dispatch is already **transport-agnostic**:
`dispatchProjectedTool(tool, name, args, ctx, deps)` (`libs/generic/tooldef/src/dispatch-projected.ts`)
runs ONE ordered pipeline (`dispatch-stack.ts:52–559`: default-deny → role-allowlist → capability-check
→ capability-envelope → role-requirement → harness → quota → authorize → preconditions → timeout →
invoke) for **MCP, HTTP, and IPC alike**. **Code-mode is just a new caller of that dispatch** — it
reuses auth, capability gates, the envelope (`deps.checkCapabilityEnvelope`), and audit/telemetry
(`postInvoke`) UNCHANGED. Not a parallel tool system.

**Source of truth:** the central registry — `getCatalog()` (`registry.ts:64`) /
`listAllProjectedTools()` (`tool-projection.ts`) — an iterable map of every tool def: `name`, zod
`args`, `capability`, `tier`, `guidance`, `handler`, `profile`. We codegen the facade from this; compound
tools look up from it. (`defineTool` itself: `libs/generic/tooldef/src/define-tool.ts:206`; tool shape:
`types.ts:395` ToolDefinition [principal-gated] / `types.ts:571` RoleToolDefinition [requirePrincipal:false,
agentRoles — most agent-facing tools].)

**Path B — compound tools (trivial, no new infra):** a `defineTool` whose handler calls
`dispatchProjectedTool` per step with the SAME `ctx`+`deps` → inherits gating/envelope/audit. Lives in
`agent-tools/` like any tool. (Survey confirmed the exact `meta:batch`-style pattern.) Phase 1B.

**Path A — general runtime (clean seam):**
1. **Codegen a typed TS facade** from the registry at startup — one `tools.<ns>.<verb>(args)` per tool
   (types from the zod `args` via `toJsonSchema`), each calling `dispatchProjectedTool`. Stays in lockstep
   with the tool defs.
2. **Sandbox ctx:** facade calls dispatch with a `UnifiedToolContext` (`tool-projection.ts:307`) carrying
   the agent's `role`/`workspaceId`/`harnessSlug`/`runId` + a `principal` scoped to the agent's
   capabilities, so capability-check + envelope gate exactly as for MCP. Role-gated tools
   (requirePrincipal:false — coord/work_items/plans) need only the UnifiedToolContext; principal-gated
   tools get the principal+tx the HTTP transport already supplies (the projected wrapper,
   `define-tool.ts:461`, handles the adapt).
3. **`code:run` is itself a `defineTool`** — handler runs the submitted TS in the sandbox with the scoped
   facade injected, returns the summary. The envelope/blueprint-deps already gate WHO gets `code:run`.
4. **Static parse-checks:** AST-walk the script; the facade's names are the known/allowed set → flag
   unknown/disallowed tool calls before execution.
5. **Catalog hook:** present the facade's TS type-signatures (not the full JSON catalog) for code-mode,
   with on-demand signature loading (the Anthropic tool-def-overhead win) — hooks `renderToolCatalog`/
   prompt-assembly.

**THE prerequisite gap (safety): no read/write marker on a tool def.** `ToolDefinition` has no
`mutating`/`effect` field → dry-run/confirm (D-003) can't gate writes by mutability today. Fix: add
`effect: 'read' | 'write'` to `defineTool` (stopgap: infer from the `:write` capability suffix —
fragile). Small, well-defined; a hard prerequisite for letting model-written code call mutating tools.

### Briefs refined (supersede §7 specifics)
- **B-CX-PRE — add `effect: 'read'|'write'` to `defineTool` + backfill agent-facing write tools.** Small;
  unblocks the mutating-tool gate. (Independent — buildable first.)
- **B-CX-1B — compound tools** (Phase 1B): `defineTool`s composing `dispatchProjectedTool` calls + summarized
  returns, for the top measured hotspots. No facade, no sandbox.
- **B-CX-1A — facade + sandbox runtime** (Phase 1A, if §4→A): codegen the typed facade from the registry +
  the sandboxed executor + the scoped `UnifiedToolContext`, all calling `dispatchProjectedTool`.
- **B-CX-2A — `code:run` defineTool + static parse-checks + dry-run/confirm gating** (deps B-CX-1A + B-CX-PRE).
- **B-CX-3 — prompt guidance + convert exemplars + measure** (deps the chosen path + B-TOK).
