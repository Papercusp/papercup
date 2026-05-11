---
title: Compared to other frameworks
description: 11+ frameworks we surveyed, what we kept, what we rejected, what we invented.
---

We surveyed every Claude Code agent framework we could find before deciding to write our own. Here's the matrix.

| Framework | Author / Org | Core idea | Closest pattern we adopted |
|---|---|---|---|
| gstack | Garry Tan (YC) | 23 role-based slash commands, "boil the lake" | Boil the lake principle in 5 role prompts |
| Superpowers | Jesse Vincent | 7-phase TDD iron law | TDD iron law in validator |
| GSD | Lex Christopherson | Per-phase orchestrators with state-to-disk | Fresh contexts + cache-stable prompts |
| Agentwise | Phil | 8 specialist agents in parallel + dashboard | Real-time dashboard pattern |
| Hermes | (referenced in gstack) | Autonomous orchestration with checkpoints | Named checkpoints |
| Multi-Agent Ralph Loop | alfredolopez80 | MemPalace 4-layer memory | 4-layer memory (L0-L3) |
| ComposioHQ Agent Orchestrator | Composio | Git worktrees per parallel agent | Worktrees per lane |
| OpenSwarm | unohee | Linear-driven Worker/Reviewer pair | (rejected — no external task source) |
| Conductor | $22M Series A | Two-mode parallelism | Competition mode |
| claudecode-orchestrator | darrenapfel (deprecated) | "Quality through truth" + service smoke-test | Evidence rule + smoke-test gate |
| MOLTRON | — | Self-evolving Skills.md | TRICK: convention |

Plus general-purpose: AutoGPT, LangChain, CrewAI, MetaGPT, SuperAGI, Haystack, Semantic Kernel — these aren't coding-specific and we didn't borrow patterns from them directly.

## Two ecosystem clusters

Reading the surveys, the Claude Code ecosystem clusters around two patterns:

1. **Skill packs** — gstack, Superpowers, GSD. Slash commands inside a Claude Code chat. Human is the orchestrator. Claude runs one task at a time. Useful for solo founders but not autonomous.
2. **Multi-agent runtime** — Agentwise, Hermes, Conductor, ComposioHQ. They run agents in parallel. Closer to what we needed, but each ties orchestration to *their* opinion of how the company should work.

We landed in a third cluster: a tiny supervised loop that owns no opinion about the *company*, just the *agent runtime*.

## What we borrowed

| From | Pattern | Our adoption |
|---|---|---|
| Superpowers | TDD iron law | Validator HARD RULE: behavioural assertions need failing-then-passing test |
| gstack | Boil the lake | Added to debugger / ui-qa / curator / product / architect prompts |
| claudecode-orchestrator | Quality through truth | Validator EVIDENCE RULE: quote source output to claim PASS |
| claudecode-orchestrator | Service smoke-test | `bin/service-smoke-test.sh` + `smokeTest.onDone/onFeaturePass` |
| Hermes | Named checkpoints | `CHECKPOINT <name>` decision verb + `triggerOn: post-planner` auto-fire |
| Composio | Git worktree per agent | `branchIsolation.useWorktrees` + `worktree_*` fns |
| Conductor | Multi-worker on same feature | `parallelWorkers.workersPerFeature > 1` + synthesizer merge |
| Agent Swarm | Per-agent IDENTITY.md | `~/autonomous-harness/identity/<role>.md` cross-mission append-only |
| MOLTRON | Self-evolving learnings | Worker `TRICK:` convention promoted by curator |
| Ralph Loop | 4-layer memory | L0 runtime / L1 raw / L2 summary / L3 MEMORY / L4 identity |
| GSD | Per-phase orchestrators with state-to-disk | Fresh-context per role per iteration |
| Agentwise | Real-time dashboard | Next.js `/harness` UI |

## What we rejected

| From | Pattern | Why rejected |
|---|---|---|
| OpenSwarm | Linear/Notion task source | User explicit: no external task source |
| OpenSwarm | LanceDB vector memory | Overkill at our scale |
| Claude-Swarm | Tmux-based agent messaging | File-based simpler |
| Agentwise | Discord/Slack control | UI-coupled |
| MOLTRON | Workers rewrite their own prompts | Audit / determinism preferred |
| AutoGPT | Infinite loop, no decision verbs | Drift catastrophe |
| LangChain | Heavyweight Python runtime | Bash + claude won |
| All "skill packs" | Human as orchestrator | We needed autonomous loop |

## What we invented

| Pattern | Why we needed it | Where it lives |
|---|---|---|
| **Decisions timeline + ghost rate** | Detect orchestrator parser regressions | `/api/harness/:slug/decisions` + dashboard panel |
| **Cost-per-feature attribution** | Per-session cost tracking is too coarse | Filename tag pattern: `<ts>-<role>-<fid>.jsonl` → `/usage byFeature` |
| **Plan-reviewer as autonomous gate** | gstack's `/plan-ceo-review` is human-triggered; ours fires automatically | `prompts/plan-reviewer.md` + run.sh gate |
| **Autonomous scope-expansion (scoper MODE=proposal)** | MOLTRON evolves capabilities; we wanted scope expansion | `prompts/scoper.md` (the proposal-mode section) reading SPEC.md's north-star vs current scope + proposals CRUD. *Pre-2026-04-25 this lived in a separate `prompts/product.md`, since consolidated; the legacy file is at `prompts/_archived/product.md`.* |
| **Proposals CRUD with bulk accept/reject** | Operator triage workflow | `.harness/proposals/*.md` + dashboard 🪄 tab |
| **Per-feature timeline** aggregating snapshots + agent runs + debug + PR | Forensics replacement for log scrolling | `/api/harness/:slug/features/:id/timeline` |
| **Health endpoint with 9 composite checks** | One-glance system health | `/api/harness/:slug/health` |
| **Org layer**: 5 fixed director agents coordinating via 17 typed message kinds with server-side validation + ACTIONS contract for autonomous workers | We needed an outer-loop "company" model that didn't exist anywhere | `apps/web/app/api/_hono/org.ts` + `~/.restart-org/` + `~/org-{dept}/.harness/` |

## The bet

The cheapest, most maintainable autonomous coding rig is:

1. A small bash supervisor with no agent-runtime opinion (~1500 lines).
2. Stable per-role markdown prompts (so prompt-cache hits dominate).
3. Files-on-disk for state (so any role can re-derive from scratch).
4. A curator role for memory compaction.
5. Observability over autonomy — show every decision the orchestrator made.

So far: 99.94% cache-hit rate, 22/37 features green at iteration 5 of the live mission, $135/mission, ~$0.05/role-invocation effective cost.
