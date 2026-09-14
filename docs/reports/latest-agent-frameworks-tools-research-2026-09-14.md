# Latest Agent Frameworks and Tools — Borrow/Adapt Landscape

## Executive summary

Yes. The June 1–September 14, 2026 release window produced several useful projects that were not materially covered in Papercusp's existing framework, engine, memory, protocol, browser, sandbox, or evaluation reviews. The strongest opportunities are mechanisms, not replacement platforms.

Four actions are worth starting now:

1. **Build a dual-stack MCP 2026-07-28 migration.** This is the only urgent compatibility issue found. The new protocol removes `initialize`, `notifications/initialized`, `Mcp-Session-Id`, `ping`, HTTP GET streams, and resumable SSE; adds `server/discover`, per-request version/capability metadata, `subscriptions/listen`, required `resultType`, multi-round-trip results, cache hints, and deterministic list ordering. Papercusp currently pins the legacy TypeScript SDK line and has load-bearing initialization enrichment and UDS handshake logic. A flag-day upgrade would break session-start context delivery and transport identity; a tested dual-era adapter is required.[^1][^2][^3]
2. **Add a three-tier quality lifecycle for Agent Skills.** NVIDIA's new SkillEvaluator cleanly separates deterministic validation/security checks, semantic duplication/context checks, and live skill-on-versus-skill-off evaluation. Papercusp already has skill creation/installation, rubrics, scorecards, and execution benchmarks, but no equally explicit skill-specific promotion funnel. Borrow the contract and fixtures through existing evaluation surfaces rather than adopting a second control plane.[^4][^5]
3. **Make uncertainty and residue first-class in code-context and test-selection answers.** Ripwire's useful idea is not another repository index. It is an evidence contract: mark inferred edges, state ranking confidence separately from severity, enumerate skipped/degraded inputs, publish failed cases, and pair test recommendations with uncovered impact. Papercusp already has result-door recovery, completion coverage partitions, GitNexus evaluation, and `test:affected`; extend those surfaces instead of installing a parallel index.[^6]
4. **Add explicit leases for a person's existing browser tabs.** BrowserSkill demonstrates a strong boundary for authenticated browser work: an agent owns a separate window; touching an existing tab requires an explicit borrow; stopping returns borrowed tabs; unborrowed tabs remain inaccessible; human-only steps have a bounded handoff. Papercusp's current computer surface deliberately provisions isolated displays, so this should be a new, opt-in target class—not a relaxation of the sandbox-display rule.[^7]

Four additional mechanisms merit bounded prototypes:

- Microsoft's Skill Recorder: recorded actions → inferred intent and ordered steps → a draft reusable Skill or automation, with evaluation scenarios.[^8]
- MCP State Twin: immutable snapshots, isolated forks, deterministic tool effects, terminal-state assertions, canonical diffs, and fault injection for agent evaluation.[^9]
- Shepherd: typed substrate grants, retained per-binding changesets, recorded effects, and consume-once settlement of agent outputs.[^10]
- Unified Harness Protocol/HarnessRouter: a common harness session/stream/cancel/failure contract plus conformance vectors, used as an adapter reference rather than a new Papercusp gateway.[^11]

The research does **not** support replacing Papercusp's scheduler, coordination ledger, fleet runtime, memory system, computer sandbox, or engine layer with a newly released framework. Omnigent, Dormice, OpenBot, Artemis, Better Harness, LongHorizon Harness, and DeepSeek Harness contain useful comparison points, but most of their central value already exists in Papercusp or addresses a narrower deployment shape.[^12][^13][^14][^15][^16][^17][^18]

## Ranked decision matrix

| Rank | Candidate and current evidence | Disposition | Precise mechanism to reuse | Papercusp seam | Main risk / boundary | First falsifiable probe |
|---:|---|---|---|---|---|---|
| 1 | **MCP 2026-07-28 + TypeScript SDK v2**, final spec released July 28; v2 packages released July 27 | **Borrow now — P0** | Dual-era discovery, per-request protocol envelope, explicit handles, `subscriptions/listen`, MRTR/result types, cache TTL/scope, deterministic catalogs | MCP host, UDS transport, admission classifier, OMP round trips, session-start context delivery | Removing `initialize` without replacing its Papercusp prelude loses memory/identity/bootstrap behavior | One legacy client and one 2026 client both discover/list/call; modern path sends no initialize/session header; context arrives exactly once |
| 2 | **NVIDIA SkillEvaluator**, created June 24, Apache-2.0 | **Borrow now — P1** | Tier 1 validation/security/PII/license; Tier 2 overlap/context; Tier 3 live skill-on/off evaluation | Skill snapshot/install pipeline, rubrics, scorecards, external bench | Live eval cost and grader leakage; upstream Python stack should not become the source of truth | Run a fixed held-out task set with and without one skill; promotion requires positive effect plus clean deterministic/security gates |
| 3 | **Ripwire**, created July 29; v0.6.0 released September 11, Apache-2.0 | **Borrow now — P1, ideas first** | Confidence separate from severity; provenance per inferred edge; skipped/degraded-input ledger; loss-first benchmark reporting; uncovered impact beside tests-to-run | `search:fulltext`, result door, GitNexus comparison, affected-test selection, completion coverage | Its own benchmark figures are project-reported and its C++ index would duplicate current indexing | Add structured confidence/provenance/residue to one impact endpoint; held-out false-negative rate must improve or the change is withdrawn |
| 4 | **BrowserSkill**, created June 22, MIT | **Borrow now — P1 design** | Explicit borrowed-tab lease, separate agent window, approval policy, human takeover, release/return semantics, post-action verification | `capability:computer`, desktop lease, trajectory export, future authenticated-browser provider | Access to a real logged-in profile increases privacy and external-action risk; never weaken the default sandbox target | An unleased tab is unreachable; borrow requires policy; stop returns it to its original window/position; fill is re-read before success |
| 5 | **Microsoft Skill Recorder**, created July 29, MIT | **Prototype — P1/P2** | Convert a captured human workflow into intent + ordered steps + a draft skill; retain raw event provenance; evaluate generated skills against scenarios | Recipe capture/graduation, computer trajectory export, skill authoring and review | Screen capture may contain secrets; inferred intent can be wrong; generated output must stay draft-only | Record three bounded workflows; a reviewer can trace every generated step to captured evidence, and held-out execution beats a no-skill baseline |
| 6 | **MCP State Twin**, created August 17, MIT | **Prototype — P1/P2** | Snapshot → fork → act → assert → canonical terminal diff; isolated deterministic worlds; virtual time/fault plans; branch-independent scoring | External benchmark task sets, MCP fixtures, idempotency/fault tests | Modeled worlds can be precise but low-fidelity; upstream explicitly lacks completed differential validation and several failure modes | Model one issue/work-item world; two valid trajectories from one snapshot reach the same scored state with zero production writes |
| 7 | **Shepherd 0.3.1**, September 9, MIT | **Prototype — P2** | Named substrate grants, per-binding retained changesets, complete typed effect traces, consume-once `select/apply/release/discard` | Existing file locks, isolated benchmark checkouts, work-item completion evidence, git-sync resolver | Do not introduce a second workspace or commit authority; returned handles and public replay are roadmap, not shipped | Produce an inspectable changeset view for one isolated agent run; double settlement and stale-basis settlement must fail closed |
| 8 | **UHP/HarnessRouter**, repo created August 9; v0.17.1 September 13, Apache-2.0 | **Prototype — P2** | Engine-neutral sessions, streaming, cancellation, files, failure taxonomy, and versioned conformance reports | Existing `capability:launch-agent`/engine adapters and session-port events | Young protocol, fast churn, and overlap with Papercusp's richer identity/coordination model | Map two current engines to a thin UHP adapter and run upstream conformance; no new durable session store |
| 9 | **Omnigent 0.13.0**, September 9, Apache-2.0 | **Watch / selectively adapt** | Adapter capability matrix, fail-closed sandbox differences, typed policy registry, multi-provider session parity | Launch-agent adapters, provider-neutral workspace-host contract, capability policy | Wholesale adoption duplicates orchestration, policies, UI, session sync, and sandbox abstractions | Compare current adapters against its capability/failure matrix; adopt only missing conformance cases |
| 10 | **Dormice**, created July 8, Apache-2.0, explicitly early development | **Watch; benchmark lifecycle** | Idempotent key→sandbox acquire; active→frozen→stopped→archived cooling; honest slow restore; E2B-compatible face | Workspace-host provider contract and future sandbox lifecycle | Single-machine Docker+gVisor design; not production-ready; security/isolation differs from VM-backed hosts | Measure memory reclaimed, wake latency, disk retention, and isolation on one disposable host before any provider work |
| 11 | **OpenBot**, created August 17, MIT | **Watch / compare** | Decide before computer action, record after, per-agent computer, AG-UI boundary | Computer policy/audit and potential AG-UI adapter | Large application stack; duplicates agent UI, policy, audit, and computer supervisor | Compare its audit record to Papercusp's computer trajectory for one real action; borrow only missing fields |
| 12 | **Artemis**, created August 13, Apache-2.0 | **Watch — domain-specific** | Android incident memory, independent checker, context compression, workflow-level validation | Future mobile/Android computer provider | Android-only; headline benchmark is project-reported and was not independently reproduced | Revisit only when Android automation becomes a Papercusp requirement |
| 13 | **Better Harness**, created July 21, MIT | **Already covered; mine tests/docs** | Explicit evidence states, missing-evidence disclosure, longitudinal task-loop evaluation | Existing plan BARs, rubrics, scorecards, completion evidence, improvement capture | Installing it would create a second improvement/evaluation workflow | Diff its five dimensions against current acceptance/evidence schema; file only concrete uncovered clauses |
| 14 | **LongHorizon Harness 0.1.7**, August 20, MIT | **Already covered; benchmark comparator** | Fresh-context rounds, durable task state, independent auditing, recoverable progress | Cold carry, work-item checkpoints, plan dependencies, external bench | Reported gains are upstream measurements; core orchestration overlaps strongly | Run the same long-horizon task through both systems only if a current Papercusp failure class lacks coverage |
| 15 | **DeepSeek Harness 0.1.5 RC**, September 10, MIT | **Already covered / watch** | Everything-as-plugin packaging and portable session formats | Existing plugin system and engine comparison lane | Pre-1.0 churn; another runtime would not replace Papercusp's coordination plane | Keep as an external engine arm; borrow only a demonstrated plugin/session-format advantage |

## Scope, method, and meaning of “not looked at yet”

### Research window

The release window is **June 1 through September 14, 2026**. Older projects were included only when a materially new release landed in that window. Sources were frozen at the research cutoff; release state after September 14 is outside this report.

The census covered seven adjacent areas:

| Area | Existing Papercusp baseline | Newly examined cohort |
|---|---|---|
| Agent runtimes and orchestration | OMP/open-code mechanics; LangGraph, CrewAI, OpenHands benchmark arms; Claude Agent SDK, Codex app-server, goose, Gemini/Antigravity, and roll-your-own engine comparison | DeepSeek Harness, Omnigent, Shepherd, Better Harness, LongHorizon Harness |
| Coding-agent infrastructure | Fleet scheduler, work-item/plan ledgers, visible/headless launch, external benchmark harnesses, GitNexus/code-context studies | HarnessRouter/UHP, Ripwire, Skill Recorder |
| Memory and context | Mem0, Graphiti, Hindsight, Mastra observational memory, LangMem, OpenViking, context compaction/consolidation studies | No new memory database displaced the current findings; LongHorizon and Artemis contributed continuity/compression comparisons |
| Interoperability and tool protocols | MCP, A2A, AG-UI/ACP concepts and engine adapters | MCP 2026-07-28 final revision, UHP/HarnessRouter, current Agent Skills specification |
| Evaluation and observability | Rubrics, scorecards, acceptance BARs, external benchmark arms, work-item completion evidence | SkillEvaluator, MCP State Twin, Better Harness comparison |
| Browser and computer use | Isolated Xvfb/bubblewrap desktops, computer trajectories, Tauri and Playwright acceptance | BrowserSkill, OpenBot, Artemis |
| Sandbox and execution systems | Provider-neutral durable workspace hosts, isolated desktops, E2B/Daytona/microsandbox awareness | Dormice, Omnigent provider matrix; Pullrun screened but not promoted |

“Not looked at yet” is applied conservatively. A candidate counts as novel here only when no material prior evaluation, implementation dependency, benchmark arm, plan/work-item, report, or indexed session record was found. Exact-name repository searches were combined with workspace full-text records and concept-level baseline reviews; absence from one file or one grep was not treated as proof. This definition does not claim that no individual has ever seen a project—it means no durable Papercusp evaluation was found.

The evidence pass used official release records and documentation first, then pinned repository source and license files. Marketing claims were not promoted to Papercusp measurements. Representative implementation files were inspected for the strongest candidates; every project in the wider discovery set was not executed or benchmarked locally.

## Prior-review baseline

Papercusp has already reviewed the obvious incumbent frameworks and several adjacent systems deeply enough that another generic survey would mostly repeat work.

- The external benchmark registry already models OpenHands, CrewAI, LangGraph, and ROMA against the same backlog/evidence framework, with framework-specific drivers and coordination-quality scoring.[^19]
- The August engine comparison covered open-code server/SDK, Claude Agent SDK, Codex app-server/SDK, goose/ACP, Gemini/Antigravity, OMP, and a small custom engine. It concluded that open-code was the strongest greenfield multi-provider engine candidate while preserving provider-specific engines where authentication and policy demanded them. This report treats that as settled baseline rather than reopening engine selection.[^20]
- Separate research on context compaction and knowledge graphs already covers Mastra observational memory, Hindsight, Mem0, Graphiti, LangMem, OpenViking, LightRAG, and related papers. Its central conclusion—extend the canonical PostgreSQL-backed system and test narrower retrieval/consolidation mechanisms—still stands.[^21]
- GitNexus and codebase-memory alternatives were reassessed immediately before this survey. Ripwire is therefore evaluated for its uncertainty and residue contract, not assumed to be a missing graph engine.[^22]
- A2A and AG-UI remain relevant interoperability references, but their current release activity does not create a stronger near-term action than MCP 2026-07-28. A2A's latest tagged release predates the window; AG-UI is active but its frontend-event role is already understood and separate from MCP's tool protocol.[^23]

Current incumbent release activity was also checked. Microsoft Agent Framework, Google ADK, Strands Agents, OpenAI Agents SDK, LangGraph, CrewAI, PydanticAI, Mastra, Agno, LlamaIndex, and Deep Agents all shipped during the window. Those releases show ecosystem vitality; none exposed a Papercusp gap more specific or valuable than the mechanisms ranked above. AutoGen had no current-window release and smolagents' latest tagged release fell before June 1.[^24]

## Finding 1 — MCP 2026-07-28 is a migration, not a routine dependency bump

The final 2026 revision changes the protocol's lifecycle model. It is not just additive.

### What changed

The official changelog records these load-bearing changes:[^1]

- protocol sessions and `Mcp-Session-Id` are removed;
- `initialize` and `notifications/initialized` are removed;
- every request carries protocol version and client capabilities in `_meta`;
- `server/discover` becomes mandatory for version and capability discovery;
- opted-in server notifications move to `subscriptions/listen`;
- results carry required `resultType`, including `input_required` for multi-round-trip requests;
- resumable/redelivered SSE is removed, so a broken stream requires a new request ID;
- list/read results carry `ttlMs` and `cacheScope`;
- deterministic list ordering is recommended for client and prompt caching;
- roots, sampling, logging, legacy HTTP+SSE, and dynamic client registration are deprecated or redirected;
- JSON Schema 2020-12 composition and `$ref` behavior is widened and resource-bounded.

The TypeScript SDK shipped new v2 packages for this revision while preserving a legacy v1 line. The new packages include `@modelcontextprotocol/core`, `server`, `node`, and framework adapters; the v2 release notes explicitly point to a 2026 migration guide. The legacy package's 1.30.0 release remains on the old lifecycle.[^2]

### Why Papercusp is exposed

Papercusp manifests currently specify `@modelcontextprotocol/sdk` `^1.29.0`, and the installed package reports 1.29.0. That runtime's `LATEST_PROTOCOL_VERSION` is `2025-11-25`; its supported list does not contain `2026-07-28`.[^3]

Several Papercusp behaviors are coupled to the old handshake:

- `_mcp-host.ts` wraps the SDK's private stored `initialize` handler and appends the session-start memory/insights prelude to `initialize.instructions`.
- `_mcp-uds.ts` requires `initialize`, waits for the response, requires `notifications/initialized`, and treats later identity-bearing initialization as a forbidden rebind.
- admission classification reserves capacity for `initialize`, `ping`, and `tools/list` as handshake/diagnostic traffic.
- OMP integration tests exercise initialize → initialized → list/call and explicitly use `2025-06-18` in places.
- HTTP identity still recognizes `Mcp-Session-Id` as a fallback, although explicit Papercusp launch identity already outranks it.

These are deliberate, tested mechanisms. Deleting them to “support stateless MCP” would regress context delivery, authentication binding, admission behavior, and compatibility with current clients.

### Recommended migration shape

1. **Freeze a two-era compatibility matrix.** Cover a current v1 client, a v1 stateless HTTP client, a 2026 client, and both STDIO/UDS and Streamable HTTP where applicable. Pin discovery, list, call, cancellation, notification, schema, auth, cache, and disconnect semantics.
2. **Upgrade the legacy line from 1.29 to 1.30 separately.** This captures the final v1 fixes without pretending it enables the 2026 wire.
3. **Add a narrow modern adapter around v2 packages.** Keep Papercusp's tool registry, authorization, admission, and dispatch as the authority. The adapter translates only lifecycle/envelope/transport concerns.
4. **Replace initialize-only prelude delivery explicitly.** Modern clients should receive required standing context through a typed bootstrap/orient path or a bounded first-request prelude with an exactly-once delivery ledger. Do not hide mutable session state inside a new transport shim.
5. **Use explicit Papercusp identity on every modern request.** The existing `x-papercusp-client`/launch SID is already closer to the new model than transport session IDs. Remove `Mcp-Session-Id` only from the modern branch; retain it for old clients.
6. **Normalize result eras at the edge.** Treat a missing legacy `resultType` as `complete`, preserve structured content, validate MRTR inputs, and make retries use new request IDs without losing Papercusp idempotency keys.
7. **Adopt caching only with invalidation proof.** Deterministic tool ordering and TTL/scope hints can reduce catalog tokens, but private tool lists must not leak through shared caches. Existing `list_changed`/dynamic-catalog behavior needs a compatibility test before nonzero TTLs.
8. **Make modern subscription ownership explicit.** `subscriptions/listen` should feed the existing event/watch infrastructure rather than establish a parallel notification ledger.

This deserves its own multi-file implementation plan. It is higher priority than adopting any new agent framework because client/SDK upgrades can otherwise turn current MCP behavior into a hard interoperability failure.

## Finding 2 — Agent Skills need a promotion funnel

The Agent Skills specification standardizes a directory with `SKILL.md`, required `name` and `description`, optional compatibility/tool metadata, progressive disclosure, scripts, references, and assets. The format is intentionally permissive; conformance alone says little about safety, duplication, or behavioral value.[^4]

SkillEvaluator fills that gap with three independent tiers:[^5]

1. **Validation:** schema, quality, Unicode, scripts, PII, license, and optional security/LLM rubric checks.
2. **Deduplication/context:** similarity and context-optimization checks against existing skills and within a skill.
3. **Live evaluation:** dataset creation, sandboxed agent execution, comparison, and reporting to determine whether the skill changes behavior usefully.

Papercusp should borrow the lifecycle, not make the NVIDIA CLI its authority. The existing skill snapshot/install path can emit a content digest and manifest. Existing rubrics and scorecards can express quality/security bars. The external benchmark runner can execute skill-on/skill-off arms under the same model, account, prompt, repository, and budget.

A proposed promotion state machine is:

`draft → deterministic-clean → novelty-reviewed → live-positive → published`, with any stage able to return `rejected` or `needs-human`.

Minimum evidence per stage:

| Stage | Required evidence |
|---|---|
| deterministic-clean | valid frontmatter and paths; script syntax; forbidden-secret and PII scan; license/provenance; bounded dependency manifest |
| novelty-reviewed | nearest existing skills; overlapping instructions/resources; reason to merge, extend, or remain distinct |
| live-positive | held-out tasks; no-skill baseline; skill-enabled arm; same model/effort/account; task outcomes and cost; grader independence |
| published | immutable content digest; source/provenance; supported hosts; compatibility constraints; rollback/disable path |

The falsifier is important: if a skill does not improve task outcomes or merely increases verbosity/cost, it should not graduate. The system should preserve negative results so the same skill is not repeatedly re-proposed.

## Finding 3 — Honest residue is more valuable than another code index

Ripwire combines lexical and structural retrieval, impact analysis, tests-to-run, code-quality lenses, and compact signature bundles. Its in-repository evaluations report large byte reductions for some signature bundles and publish paired losses and counterexamples. Those figures were not independently reproduced here and should not be used as Papercusp performance claims.[^6]

The transferable design is the output contract:

- confidence says how clearly the evidence separates a best answer, not whether the answer is true;
- severity/risk is independent of confidence;
- inferred graph edges carry provenance and weaker edges are visually distinct;
- skipped, oversized, excluded, unsupported, degraded-parse, and minified inputs remain enumerable;
- tests-to-run can state `run_unknown` and uncovered impacted symbols rather than silently returning a short list;
- evaluation publishes losses beside wins, including mechanisms that were built, measured, and withdrawn.

Papercusp already has the right homes for this information. Completion verification includes `checked`, `notChecked`, `notApplicable`, and residue. Result-door envelopes distinguish omitted from recoverable spilled output. `search:fulltext` and GitNexus cover retrieval, while `test:affected` is the release gate. The missing step is to standardize evidence quality on context/impact/test answers.

A minimal shared envelope would include:

```text
answer[]                  selected files, symbols, or tests
provenance[]              exact, static-edge, history-edge, heuristic, model
confidence                high | medium | low | abstain
confidenceBasis           measured margin or explicit reason
population                what could have been considered
notChecked[]              known inputs omitted from analysis
degraded[]                inputs parsed or indexed with reduced fidelity
residue[]                 affected areas with no supported answer
nextProbe                 cheapest action that would reduce uncertainty
```

The first application should be affected-test selection, where a confident false negative can freeze the shared release gate. Measure held-out miss rate and abstention quality before widening use.

## Finding 4 — Existing browser state should be leased, never ambient

BrowserSkill allows agents to use an already logged-in Chrome/Edge profile while preserving an explicit boundary. A session gets a separate Agent Window. A user tab must be borrowed into it; unborrowed tabs are out of scope; closing a borrowed tab is refused until return; stop attempts to return borrowed tabs; human assistance is an explicit request with policy and timeout behavior.[^7]

This is relevant because some high-value workflows cannot be reproduced in an empty browser: authenticated admin panels, enterprise applications, and stateful local tools. It is also dangerous because a logged-in profile is an authority bundle.

Papercusp should retain its current isolated-desktop default. Add a distinct **authenticated external browser** provider only when the owner explicitly selects it. Its lease record should bind:

- person/profile and browser instance;
- session/agent identity;
- exact tab ID and original window/index;
- allowed origin(s) and operation class;
- approval mode and expiry;
- whether the task may navigate away, upload, download, or submit;
- return outcome and any unresolved side effect.

Actions that change external state should still respect Papercusp's outward-action gate. A successful click or fill must be followed by a readback or observable state transition before the tool reports success. Stopping the agent should return borrowed tabs and surface any failure rather than silently abandoning them.

## Prototype portfolio

### Trace-to-skill generation — Microsoft Skill Recorder

Skill Recorder records a desktop work session, reconstructs an intent and ordered steps, and generates a reusable Skill or automation. The repository includes event types, generation instructions, and evaluation scenarios rather than only a demo UI.[^8]

Papercusp already captures successful multi-tool `code:run` traces into recipes, deduplicates them, ranks reuse, and supports graduation. The natural extension is **multimodal recipe capture**:

1. capture a bounded computer/terminal trajectory with timestamps and redaction;
2. segment it into typed actions and observable postconditions;
3. infer a proposed intent and parameter slots;
4. generate a draft recipe or Skill, never auto-publish it;
5. run static/novelty/live gates from the skill promotion funnel;
6. preserve source-event references so a reviewer can audit every generated step.

This reuses Papercusp's recipe store and promotion path. A parallel recorder database or skill registry is unnecessary.

### Deterministic stateful tool worlds — MCP State Twin

MCP State Twin's most useful idea is to make the environment deterministic while allowing the model to remain nondeterministic. Multiple runs start from the same immutable snapshot, act on isolated branches through the same modeled tool surface, and are compared by assertions and canonical terminal-state diffs.[^9]

The source implements SQLite-backed branches and snapshots, state digests, virtual clocks, bounded canonical JSON Pointer diffs, optimistic head versions, resource limits, and two fault phases. Its own status document is candid: recorder/cassette replay, complete differential validation, several distributed failure semantics, production authentication/TLS/multi-tenancy, and exactly-once external effects are not complete.[^9]

Papercusp should prototype this inside the existing external benchmark harness. A first twin can model work-item claiming/completion and include these cases:

- two agents take different valid call sequences but reach the same terminal state;
- duplicate/retried calls preserve idempotency rules;
- an after-commit-before-response fault produces an unknown outcome that the agent reconciles by reading state;
- a branch cannot mutate another branch or production;
- scoring uses terminal invariants, not exact trajectory matching.

If maintaining the twin costs more than the failure classes it exposes, stop. Fidelity must be measured against real traces before using results for promotion decisions.

### Typed agent outputs and consume-once settlement — Shepherd

Shepherd treats the world a task may change as a named, granted substrate. A run returns an inspectable per-binding changeset computed from its trace; retained output is settled once with `select`, `apply`, `release`, or `discard`. Stale-basis and overlapping settlement fail closed. The run record preserves outcomes, effects, artifacts, and usage across success, failure, exhaustion, and cancellation.[^10]

Several attractive parts are still roadmap: returned substrate handles, public replay, typed projection from captured work, durable child tasks, and task-as-value delegation. Recommendations must stay on the shipped side of that boundary.[^10]

Papercusp already has stronger multi-agent coordination, file locks, a shared canonical tree, work-item evidence, and a git-sync resolver. It should not adopt Shepherd as a second workspace system. A bounded prototype can instead define a `ChangeEvidence` view over an isolated run:

- input basis SHA and granted roots;
- changed/deleted paths and content hashes;
- tests and artifacts emitted;
- trace references and cost;
- a single terminal disposition;
- a refusal if the basis advanced incompatibly.

This could improve review and benchmark evidence without changing commit ownership.

### Harness interoperability and conformance — UHP/HarnessRouter

HarnessRouter exposes multiple coding-agent harnesses through a Unified Harness Protocol covering sessions, streaming, files, cancellation, and failure handling. Its repository carries a versioned protocol and conformance reports, which is more useful than another generic “one API” claim.[^11]

Papercusp already has engine-specific launch and session adapters plus its own identity, fleet, plan, and event semantics. Use UHP as a **boundary test corpus**:

- normalize start/resume/cancel/end outcomes across two engines;
- preserve raw engine events while emitting a stable minimal session stream;
- map capability gaps explicitly rather than returning empty success;
- test cancellation and transport loss separately from agent failure;
- keep Papercusp work-items, identity, and authorization outside the UHP payload.

A successful prototype yields a thin adapter and conformance evidence. It does not add a new daemon, session ledger, or public standard dependency until interoperability demand exists.

## Watchlist and no-adoption decisions

### Omnigent

Omnigent is the closest new platform-level comparator. It wraps Claude Code, Codex, Cursor, OpenCode, Hermes, Pi, and custom agents; supports multiple sandbox providers; exposes runtime policies; syncs sessions across clients; and is Apache-2.0. The README also documents degraded Windows isolation instead of implying parity.[^12]

Those are good adapter-quality and disclosure patterns. Papercusp already owns the corresponding orchestration, policy, session, account, and workspace-host layers. A second meta-harness would multiply state and failure ownership. Watch its capability matrix and conformance cases; borrow missing adapter tests only.

### Dormice

Dormice has a compelling lifecycle: idempotent key-to-sandbox acquisition and automatic active → frozen → stopped → archived cooling, with an E2B-compatible API and explicit slow-restore state. It reports about 50 ms wake from frozen and large resident-memory reduction on its measured host, but labels itself early development and not production-ready.[^13]

Papercusp's provider-neutral workspace-host contract is the reuse seam. If persistent sandbox cost becomes material, benchmark the lifecycle and possibly add a provider. Do not copy its single-machine Docker+gVisor architecture into the core or treat upstream resource numbers as Papercusp measurements.

### OpenBot

OpenBot gives each agent a computer, runs actions through a policy decision point, records audit events, and accepts AG-UI agents. These reinforce Papercusp's existing computer-policy and trajectory model.[^14] Compare event schemas and human-takeover behavior, but do not adopt its application/server stack.

### Artemis

Artemis combines Android automation, incident-guided recovery, a checker, and context compression. Its source is useful if Papercusp adds an Android provider.[^15] Until then, it is a domain-specific watch item. The project's 99%+ AndroidWorld statement is an upstream claim, not an independently verified result.

### Better Harness

Better Harness evaluates task understanding, controlled execution, validation, delivery, and learning capture, while keeping missing evidence explicit.[^16] Papercusp already has plan requirements/BARs, route and lock enforcement, tests, release gates, work-item completion evidence, scorecards, and improvement capture. Its documentation may reveal missing acceptance clauses; installing its workflow would duplicate the control loop.

### LongHorizon Harness

LongHorizon Harness uses fresh-context rounds, durable state, independent audit, recovery, and multiple underlying agent runtimes.[^17] Papercusp already supports warm/cold carry, deterministic checkpoints, plans, dependencies, event wakes, and leader/member supervision. Treat it as a benchmark comparator. Its published gains on WeaveBench, OSWorld, and Terminal-Bench are upstream measurements and were not reproduced.

### DeepSeek Harness

DeepSeek Harness's “everything is a plugin” architecture and portable session/storage packages are notable, and its September releases show rapid adoption.[^18] Papercusp already has plugins, skills, providers, and engine abstraction. Keep it in the external engine census; revisit only when a concrete plugin lifecycle or session-format test beats current behavior.

### Screened but not promoted

- **Graft** and related code-context tools were not promoted because the immediately preceding GitNexus/Ripwire context studies already cover the relevant decision, and no stronger gap survived comparison.[^22][^25]
- **Pullrun** offers an OCI/Firecracker/container sandbox runtime and native agent integrations, but its maturity and current Papercusp fit were weaker than Dormice's explicit lifecycle contract and the existing workspace-host seam.[^25]
- **OpenBot-style AG-UI**, **A2A**, and **ACP** remain useful protocol references, but none supersedes Papercusp's current coordination or makes a stronger immediate case than MCP 2026-07-28.[^23]
- Fast-moving incumbent agent SDK releases are retained as benchmark/adapter inputs, not separate adoption projects.[^24]

## Recommended implementation sequence

### 0–30 days

1. **MCP modernization plan.** Inventory every initialize/session-header/list-notification dependency; define a two-era adapter; add conformance fixtures before changing production behavior.
2. **Skill promotion spike.** Run deterministic checks and a skill-on/off benchmark for one existing skill through current rubrics/scorecards.
3. **Evidence envelope.** Add provenance/confidence/degraded/residue fields to one affected-test or impact-analysis response and measure missed obligations.
4. **Authenticated-browser design.** Specify the external-browser provider and borrowed-tab lease without enabling it by default.

### 30–60 days

5. **Trace-to-skill prototype.** Extend recipe capture with one bounded computer trajectory and draft-skill generation.
6. **State-twin prototype.** Model a small work-item world and run state-scored branches under the external benchmark harness.
7. **UHP adapter spike.** Map two engines and run the upstream conformance cases without introducing a second ledger.
8. **Typed changeset experiment.** Emit a consume-once change-evidence object for isolated benchmark runs.

### Later / trigger-based

- Benchmark Dormice only when durable sandbox idle cost is a measured constraint.
- Revisit Artemis only for Android/mobile automation.
- Revisit OpenBot only for AG-UI computer interop.
- Revisit Omnigent/DeepSeek/LongHorizon/Better Harness when a current Papercusp failure class maps to a mechanism not already present.

## Acceptance tests for the recommended work

| Workstream | Acceptance signal | Failure / kill signal |
|---|---|---|
| MCP dual stack | Legacy and 2026 clients pass discover/list/call/cancel/notification/auth/idempotency matrix; context delivered exactly once; no private cache leak | Modern path still needs initialize/session header; legacy regression; identity/context duplication; unbounded compatibility code |
| Skill promotion | Deterministic/security gates clean; nearest-skill overlap explained; held-out skill-on arm improves task outcome at bounded cost | No measurable lift, grader leakage, unsafe script/dependency, or duplicate skill |
| Evidence envelope | Held-out affected-test/impact miss rate falls or abstention reliably exposes uncertainty; every omission is partitioned | Confidence is decorative, residue incomplete, or answers get longer without reducing errors |
| Borrowed browser | Explicit lease and origin scope; unleased tabs unreachable; return restores ownership; mutations verified by readback | Ambient profile access, silent external mutation, stranded borrowed tab, or sandbox default weakened |
| Trace-to-skill | Every generated step links to captured evidence; secrets redacted; draft passes static/novelty/live evaluation | Irreproducible intent, untraceable steps, secret retention, or auto-publication |
| State twin | Same snapshot produces isolated branches and canonical terminal scoring; zero production writes | Twin fidelity cannot be distinguished from a mock or maintenance cost exceeds defects found |
| Typed changeset | Basis, grants, paths, artifacts, tests, and terminal disposition are inspectable; second/stale settlement refused | Parallel commit authority, hidden mutation, or reconciliation with the shared tree becomes ambiguous |
| UHP adapter | Two engine adapters pass stable lifecycle/stream/cancel/failure vectors with explicit capability gaps | New session store/control plane, loss of engine-specific evidence, or protocol churn dominates value |

## Risks and limitations

- **Cutoff:** sources were checked through September 14, 2026. Several projects are changing daily; pins and claims must be rechecked before implementation.
- **Discovery is broad, not mathematically exhaustive.** The open-source agent ecosystem has no bounded registry. The census combined official release APIs, topic/keyword discovery, repository history, workspace full text, and source inspection; a low-visibility project can still be absent.
- **Maturity differs sharply.** Many candidates are pre-1.0 or explicitly early development. Repository activity and popularity were discovery signals, not quality scores.
- **No upstream benchmark was reproduced.** Ripwire's compression/retrieval figures, LongHorizon's task results, Artemis's AndroidWorld result, Shepherd's performance claims, and Dormice's wake/memory figures remain project-reported.
- **Source inspection was selective.** Strong candidates received representative code and shipped/roadmap boundary inspection. Incumbent release deltas and lower-ranked discoveries received metadata/documentation screening, not a full security audit.
- **Licenses are snapshots, not legal advice.** The named repositories expose MIT or Apache-2.0 license files at the pinned revisions, but any code reuse needs file-level notices, dependency-license review, contributor provenance, trademark review, and confirmation at the exact commit copied.
- **No external package was installed or executed in Papercusp.** This report recommends experiments; it does not establish runtime compatibility, security, or performance.
- **MCP rollout will be heterogeneous.** The final spec and TypeScript SDK v2 exist, but clients and servers will migrate at different speeds. Backward compatibility is a product requirement, not optional cleanup.
- **Private workspace evidence is not externally resolvable.** WI-41178 and historical plan/work-item records support the “already reviewed” baseline inside Papercusp; public readers can independently inspect the cited repository sources but not the private ledger.

## Bottom line

The recent ecosystem does contain ideas Papercusp had not durably evaluated. The winning strategy is **selective borrowing into existing seams**:

- modernize MCP before the old handshake becomes a compatibility trap;
- give Skills an evidence-based promotion lifecycle;
- make uncertainty, skipped inputs, and uncovered impact explicit;
- lease authenticated browser state rather than granting ambient access;
- prototype trace-to-skill generation, deterministic stateful test worlds, typed changesets, and harness conformance in bounded experiments.

Everything else should remain a comparator or watch item until it demonstrates a failure-class improvement Papercusp does not already provide.

## Sources

[^1]: Model Context Protocol project, “[Key Changes — 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog),” July 28, 2026; [release record](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28). Final-spec lifecycle, transport, discovery, MRTR, result, caching, schema, authorization, and deprecation changes.
[^2]: Model Context Protocol TypeScript SDK, “[@modelcontextprotocol/core@2.0.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fcore%402.0.0),” July 27, 2026; “[v1.30.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0),” July 27, 2026. v2 support for the 2026 revision and the separate maintained legacy line.
[^3]: Papercusp, [`packages/operator-core/package.json`](../../packages/operator-core/package.json), [`_mcp-host.ts`](../../packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts#L4493), [`_mcp-initialize-enrich.ts`](../../packages/operator-core/lib/endpoint-route/routes/transport/_mcp-initialize-enrich.ts#L1), [`_mcp-uds.ts`](../../packages/operator-core/lib/endpoint-route/routes/transport/_mcp-uds.ts#L97), [`mcp-admission.ts`](../../packages/operator-core/lib/endpoint-route/routes/transport/mcp-admission.ts), and [`omp-client-stateless-roundtrip.test.ts`](../../packages/omp-plugin/__tests__/omp-client-stateless-roundtrip.test.ts). Current dependency and legacy handshake/context-delivery evidence, inspected September 14, 2026.
[^4]: Agent Skills project, “[Agent Skills Specification](https://agentskills.io/specification),” accessed September 14, 2026. Directory format, frontmatter, progressive disclosure, optional resources, and validation reference.
[^5]: NVIDIA, “[SkillEvaluator](https://github.com/NVIDIA/SkillEvaluator/tree/efcd97ae7e0d2e2179e8a87c5b30c062626f69e7),” pinned September 12, 2026 commit; [README](https://github.com/NVIDIA/SkillEvaluator/blob/efcd97ae7e0d2e2179e8a87c5b30c062626f69e7/README.md); [Apache-2.0 license](https://github.com/NVIDIA/SkillEvaluator/blob/efcd97ae7e0d2e2179e8a87c5b30c062626f69e7/LICENSE). Three-tier validation, deduplication/context, and live evaluation pipeline.
[^6]: Red Hat Emerging Technologies, “[Ripwire](https://github.com/redhat-et/ripwire/tree/0b118ac19f50aad28a350270954be93a79c7f313),” pinned September 14, 2026 commit; [README](https://github.com/redhat-et/ripwire/blob/0b118ac19f50aad28a350270954be93a79c7f313/README.md); [v0.6.0 release](https://github.com/redhat-et/ripwire/releases/tag/v0.6.0); [Apache-2.0 license](https://github.com/redhat-et/ripwire/blob/0b118ac19f50aad28a350270954be93a79c7f313/LICENSE). Context packs, impact/test mapping, confidence/provenance, skipped-input disclosure, and evaluation losses.
[^7]: Tencent, “[BrowserSkill](https://github.com/Tencent/BrowserSkill/tree/72876cc20b1cc4f3a34f9dd8a48b2e7e91f0d08f),” pinned September 12, 2026 commit; [README](https://github.com/Tencent/BrowserSkill/blob/72876cc20b1cc4f3a34f9dd8a48b2e7e91f0d08f/README.md); [tab protocol types](https://github.com/Tencent/BrowserSkill/blob/72876cc20b1cc4f3a34f9dd8a48b2e7e91f0d08f/crates/bsk-protocol/src/tools/tabs.rs); [MIT license](https://github.com/Tencent/BrowserSkill/blob/72876cc20b1cc4f3a34f9dd8a48b2e7e91f0d08f/LICENSE). Explicit borrow/return, Agent Window scope, interaction policy, and human handoff.
[^8]: Microsoft, “[Skill Recorder](https://github.com/microsoft/skill-recorder/tree/d22be1a66b250c663dde3bf202b04514ba82134c),” pinned September 9, 2026 commit; [README](https://github.com/microsoft/skill-recorder/blob/d22be1a66b250c663dde3bf202b04514ba82134c/README.md); [event model](https://github.com/microsoft/skill-recorder/blob/d22be1a66b250c663dde3bf202b04514ba82134c/common/events.ts); [skill-builder instructions](https://github.com/microsoft/skill-recorder/blob/d22be1a66b250c663dde3bf202b04514ba82134c/electron/skillbuilder/instructions.ts); [MIT license](https://github.com/microsoft/skill-recorder/blob/d22be1a66b250c663dde3bf202b04514ba82134c/LICENSE).
[^9]: MCP State Twin contributors, “[MCP State Twin](https://github.com/augety121/MCP-State-Twin/tree/49332c9a3a5f113576a2961685b84b1745550f3f),” pinned September 12, 2026 commit; [English README and status](https://github.com/augety121/MCP-State-Twin/blob/49332c9a3a5f113576a2961685b84b1745550f3f/README.en.md); [canonical diff implementation](https://github.com/augety121/MCP-State-Twin/blob/49332c9a3a5f113576a2961685b84b1745550f3f/internal/store/diff.go); [MIT license](https://github.com/augety121/MCP-State-Twin/blob/49332c9a3a5f113576a2961685b84b1745550f3f/LICENSE).
[^10]: Shepherd Authors, “[Shepherd 0.3.1](https://github.com/shepherd-agents/shepherd/releases/tag/v0.3.1),” September 9, 2026; [runtime substrate](https://github.com/shepherd-agents/shepherd/blob/d34d5ca334871dfcb5a3dc76dd78045829fa4e56/docs/shepherd/concepts/runtime-substrate.md); [runs](https://github.com/shepherd-agents/shepherd/blob/d34d5ca334871dfcb5a3dc76dd78045829fa4e56/docs/shepherd/concepts/runs.md); [grant and settlement guide](https://github.com/shepherd-agents/shepherd/blob/d34d5ca334871dfcb5a3dc76dd78045829fa4e56/docs/shepherd/guides/grant-repo-access.md); [roadmap boundaries](https://github.com/shepherd-agents/shepherd/blob/d34d5ca334871dfcb5a3dc76dd78045829fa4e56/docs/shepherd/roadmap.md); [MIT license](https://github.com/shepherd-agents/shepherd/blob/d34d5ca334871dfcb5a3dc76dd78045829fa4e56/LICENSE).
[^11]: HarnessRouter, “[HarnessRouter Community Edition / Unified Harness Protocol](https://github.com/HarnessRouter/harnessrouter/tree/c5413580d5c0c15edbb71705ef9802d92342fcba),” pinned September 13, 2026 commit; [v0.17.1](https://github.com/HarnessRouter/harnessrouter/releases/tag/v0.17.1); [versioned protocol](https://github.com/HarnessRouter/harnessrouter/tree/c5413580d5c0c15edbb71705ef9802d92342fcba/protocol/versions/2026-09-12); [conformance suite and reports](https://github.com/HarnessRouter/harnessrouter/tree/c5413580d5c0c15edbb71705ef9802d92342fcba/protocol/conformance); [Apache-2.0 license](https://github.com/HarnessRouter/harnessrouter/blob/c5413580d5c0c15edbb71705ef9802d92342fcba/LICENSE).
[^12]: Omnigent, “[Omnigent](https://github.com/omnigent-ai/omnigent/tree/dab87f8c1f6448ac5fed0270bf73a633edd534b3),” pinned September 14, 2026 commit; [v0.13.0](https://github.com/omnigent-ai/omnigent/releases/tag/v0.13.0); [README](https://github.com/omnigent-ai/omnigent/blob/dab87f8c1f6448ac5fed0270bf73a633edd534b3/README.md); [policy tools](https://github.com/omnigent-ai/omnigent/blob/dab87f8c1f6448ac5fed0270bf73a633edd534b3/omnigent/tools/builtins/policy.py); [Apache-2.0 license](https://github.com/omnigent-ai/omnigent/blob/dab87f8c1f6448ac5fed0270bf73a633edd534b3/LICENSE).
[^13]: BitMiracle AI, “[Dormice](https://github.com/BitMiracle-AI/Dormice/tree/7c8551ead0172fb09b0ac6e58ba2e58e072f0551),” pinned September 14, 2026 commit; [README](https://github.com/BitMiracle-AI/Dormice/blob/7c8551ead0172fb09b0ac6e58ba2e58e072f0551/README.md); [lifecycle policy](https://github.com/BitMiracle-AI/Dormice/blob/7c8551ead0172fb09b0ac6e58ba2e58e072f0551/packages/shared/src/policy.ts); [Apache-2.0 license](https://github.com/BitMiracle-AI/Dormice/blob/7c8551ead0172fb09b0ac6e58ba2e58e072f0551/LICENSE).
[^14]: CopilotKit, “[OpenBot](https://github.com/CopilotKit/OpenBot/tree/a97f7756d50082876cbce49d4e3bd0d18448b26c),” pinned September 13, 2026 commit; [README](https://github.com/CopilotKit/OpenBot/blob/a97f7756d50082876cbce49d4e3bd0d18448b26c/README.md); [computer gateway](https://github.com/CopilotKit/OpenBot/blob/a97f7756d50082876cbce49d4e3bd0d18448b26c/server/src/computer/gateway.ts); [audit implementation](https://github.com/CopilotKit/OpenBot/blob/a97f7756d50082876cbce49d4e3bd0d18448b26c/server/src/audit.ts); [MIT license](https://github.com/CopilotKit/OpenBot/blob/a97f7756d50082876cbce49d4e3bd0d18448b26c/LICENSE).
[^15]: Google, “[ARTEMIS](https://github.com/google/artemis/tree/371aa6df56880643da57b30da936e9812fb0ec66),” pinned September 11, 2026 commit; [README](https://github.com/google/artemis/blob/371aa6df56880643da57b30da936e9812fb0ec66/README.md); [validator incidents](https://github.com/google/artemis/blob/371aa6df56880643da57b30da936e9812fb0ec66/artemis/agents/validator/incidents.py); [checker](https://github.com/google/artemis/blob/371aa6df56880643da57b30da936e9812fb0ec66/artemis/agents/checker/checker.py); [context compressor](https://github.com/google/artemis/blob/371aa6df56880643da57b30da936e9812fb0ec66/artemis/agents/flash/context_compressor.py); [Apache-2.0 license](https://github.com/google/artemis/blob/371aa6df56880643da57b30da936e9812fb0ec66/LICENSE).
[^16]: Qoder, “[Better Harness](https://github.com/QoderAI/better-harness/tree/0e2fcd84685996b9eca44280e2ea6137ed9aaf29),” pinned September 14, 2026 commit; [README](https://github.com/QoderAI/better-harness/blob/0e2fcd84685996b9eca44280e2ea6137ed9aaf29/README.md); [MIT license](https://github.com/QoderAI/better-harness/blob/0e2fcd84685996b9eca44280e2ea6137ed9aaf29/LICENSE). Evidence-bounded Agent Work Loop model and adapters.
[^17]: AMAP-ML, “[LongHorizon Harness](https://github.com/AMAP-ML/LongHorizon-Harness/tree/a1dd930614972b92361c1b9cd6aac441a6db5a65),” pinned August 20, 2026 commit; [v0.1.7](https://github.com/AMAP-ML/LongHorizon-Harness/releases/tag/v0.1.7); [README](https://github.com/AMAP-ML/LongHorizon-Harness/blob/a1dd930614972b92361c1b9cd6aac441a6db5a65/README.md); [MIT license](https://github.com/AMAP-ML/LongHorizon-Harness/blob/a1dd930614972b92361c1b9cd6aac441a6db5a65/LICENSE).
[^18]: DeepSeek, “[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/c291e7961a515f6d7af9304e7fd1d257929aef26),” pinned September 10, 2026 commit; [0.1.5 RC release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2); [README](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/README.md); [MIT license](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/LICENSE).
[^19]: Papercusp, [`competitor-registry.ts`](../../packages/operator-core/lib/external-bench/competitor-registry.ts), [`competitor-runner.ts`](../../packages/operator-core/lib/external-bench/competitor-runner.ts), and framework drivers under [`external-bench/competitors`](../../packages/operator-core/lib/external-bench/competitors). Existing OpenHands/CrewAI/LangGraph/ROMA comparison surface, inspected September 14, 2026.
[^20]: Papercusp private work-item ledger, `WI-41178`, “Follow-up research: greenfield engine comparison — alternatives to OMP for headless agent engine + provider connections,” completed August 24, 2026. Internal access note: query through `work_items:get` in the `papercusp` harness.
[^21]: Papercusp, “[Context Compaction, Consolidation, and Retrieval](./context-compaction-consolidation-retrieval-2026-09-14.md),” “[Knowledge Graphs and Context Management](./knowledge-graphs-context-management-2026-09-14.md),” and “[PostgreSQL, Mem0, and Graph Follow-up](./postgresql-mem0-graph-follow-up-2026-09-14.md),” September 14, 2026.
[^22]: Papercusp, “[GitNexus Revised Assessment](../evidence/gitnexus-revised-assessment-2026-09-13.md),” September 13, 2026. Current code-context and graph alternatives baseline.
[^23]: A2A Project, “[A2A releases](https://github.com/a2aproject/A2A/releases),” accessed September 14, 2026; AG-UI Project, “[AG-UI Overview](https://ag-ui.com/introduction)” and [releases](https://github.com/ag-ui-protocol/ag-ui/releases), accessed September 14, 2026; Agent Client Protocol, “[Overview](https://agentclientprotocol.com/protocol/overview),” accessed September 14, 2026.
[^24]: Official release indexes, accessed September 14, 2026: [Microsoft Agent Framework](https://github.com/microsoft/agent-framework/releases), [Google ADK Python](https://github.com/google/adk-python/releases), [Google ADK JS](https://github.com/google/adk-js/releases), [Strands Agents SDK](https://github.com/strands-agents/harness-sdk/releases), [OpenAI Agents Python](https://github.com/openai/openai-agents-python/releases), [OpenAI Agents JS](https://github.com/openai/openai-agents-js/releases), [LangGraph](https://github.com/langchain-ai/langgraph/releases), [CrewAI](https://github.com/crewAIInc/crewAI/releases), [PydanticAI](https://github.com/pydantic/pydantic-ai/releases), [Mastra](https://github.com/mastra-ai/mastra/releases), [Agno](https://github.com/agno-agi/agno/releases), [LlamaIndex](https://github.com/run-llama/llama_index/releases), and [Deep Agents](https://github.com/langchain-ai/deepagents/releases).
[^25]: Trail, “[Graft](https://github.com/trailhq/Graft),” created July 3, 2026, MIT; Pullrun, “[Pullrun](https://github.com/pullrun/pullrun),” created June 11, 2026, Apache-2.0. Repository/release screening accessed September 14, 2026.
