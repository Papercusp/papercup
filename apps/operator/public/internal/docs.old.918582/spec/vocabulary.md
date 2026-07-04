# 2. Vocabulary
URL: /internal/docs/spec/vocabulary



Term
Definition
Example

Harness
A long-running iteration loop made of named roles invoked with fresh contexts that hand off via a structured state store.
The role substrate in libs/papercusp/packages/harness/.

Hive
An operator over a fleet — a root install minted from a kind:'hive' blueprint. Its single judgment layer (the Queen) surveys the blackboard, decides with agency, creates/supervises harnesses, and declares its own next wake. Distinct from a kind:'harness' blueprint, which is a feature pipeline the Hive creates.
A coding Hive from the coding blueprint, placing work onto Bees and spinning up coding-factory harnesses per feature.

Blueprint
The recipe that superseded template — a declared spine of roles, models, dispatch/triggers, and recommended plugins. kind:'hive' blueprints mint a Hive operator; kind:'harness' blueprints mint a feature pipeline.
coding (hive), coding-factory (default pipeline harness), coding-solo (single-worker baseline), research.

Bee
The generic operator-world worker the Queen places ranked work + a brief onto. Carries no pipeline spine and no chunk requirement (decoupled from the pipeline worker guards); the pipeline roles apply only when a Bee explicitly spins up a coding harness.
The Queen places a work item onto a Bee, which does the task or spins up a coding-factory harness for it.

Queen
The Hive blueprint's placement-specialist decider — the operator role tuned toward placement: bee:spawn/drain and work-list shaping. Same judgment layer as the operator, dial turned toward fleet management.
The Queen decides which Bees run, drains idle ones, and shapes the ranked work list each wake.

Install
A specific configured harness — its goal, its plugins, its UI, its DB schema. An install is what users actually run.
A coding Hive spun up from the coding blueprint. (The original Papercup 5-director autonomous-AI-company demo is retired — preserved-not-active in \_retired/papercup; migration 192 dropped the org-simulation tables.)

Role
A named agent invocation — a prompt file + an entry in the orchestrator's decision table. Always with fresh context.
The shipped pipeline roles are Scoper, Architect, Worker, Validator, Reviewer, Debugger, Documenter, Curator (the coding-factory pipeline runs scoper → architect → worker → validator → reviewer → documenter → curator). Orchestrator is a separate coordinator/decider role, not a pipeline stage — see AGENT\_ROLES in packages/agent-mcp/src/role-config.ts. Plus user-defined roles via plugins.

Harness template
A reusable recipe for spinning up a harness. One template → many concrete harness instances; each instance has its own goal, project dir, state. Templates declare their roles, default models, and the plugins they recommend.
The shipped coding blueprints: coding (the kind:'hive' Hive operator), coding-factory (the default per-feature pipeline harness), and coding-solo (the single-worker baseline). One user spins up one instance per project. (The retired papercup-org 5-department company is no longer a spinnable template.)

Plugin
A package that extends one or more harness instances with new capabilities — actions (buttons), routes, lifecycle hooks, DB schemas, custom UI tabs. Plugins are installed once globally and mounted into harness instances at runtime; their behaviour is gated by capability tiers (§10).
@papercupai/cloudflare-pages contributes a "Publish" button; @papercupai/vscode-server contributes a code-server tab; @papercupai/slack-notifier sends a Slack message on mission-done. Multiple plugins compose per instance.

Marketplace package kind
The discriminator that tells the marketplace + Cupboard which install pipeline a published artifact follows. Implemented as a five-kind storefront (LISTING\_KINDS in packages/operator-core/lib/cupboard/types.ts): harness (the repo→Hive lookup index), blueprint (a GitHub-repo-backed harness recipe — the term that superseded the original template), plugin, tool-pack (the runtime-less code-tool pack — renamed from pack by migration 008; the legacy pack value still parses as an alias), and learning-pack (a distributable set of curated hive learnings).
All five go through the same publish + signing + retraction infrastructure; only the install handler differs. blueprint + learning-pack listings publish pending and surface only after operator approval.

Goal
The top-level mission. Every task traces back to a goal through a parent chain. Goals can themselves nest.
"Build a habit-tracker mobile app and ship to TestFlight" or "Run an autonomous marketing agency."

Pending event
An entry in the queue the orchestrator reads on each tick. Sources: cron routines, webhooks, API triggers, completion deltas.
Routine "weekly-briefing" fires at 9am Monday → inserts \{\{role: narrator, due: 09:00}}.
