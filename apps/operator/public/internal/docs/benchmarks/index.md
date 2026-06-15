# Impartial benchmark suite — overview
URL: /internal/docs/benchmarks/index



import { Aside } from '@astrojs/starlight/components';

This page and [the methodology](/internal/docs/benchmarks/methodology) describe
**how** we measure, not **what** we measured. Every headline number is a
`TBD-after-pilot` placeholder until the pilot run (`P-009`) lands. No result on
these pages may be published to a third party before owner sign-off (`P-017`).
Plan of record: `impartial-benchmark-suite-2026-06-15`
(`plans:get { slug, harness: 'all' }`).

## What this is

A benchmark suite we can show **third parties** that credibly demonstrates what
the Papercusp **harness system** contributes — not just the ability of the
underlying model it runs on.

The field's 2026 consensus is that an **agent is a model embedded in an execution
system** (`Agent = Model + Harness`), and the harness is responsible for roughly
half the performance: scaffold quality alone causes \~22-point swings on identical
model weights. Leaderboards like Scale's run every *model* through *identical*
scaffolding to compare models fairly. We do the mirror image:

> **Hold the model constant. Vary only the harness.** Measure how much more the
> same model resolves — on a better cost/accuracy frontier — when it is embedded
> in Papercusp's execution system versus the provider's own native harness.

## The claim

Per decision **D-001** (framing: *both, system-delta-led*) the headline is a
**systems** claim, supported by an **absolute** number and **third-party
re-execution**:

> *Holding the model constant, the same model embedded in Papercusp's execution
> system resolves more real tasks — net of all coordination overhead, at a lower
> cost — than the same model in the provider's own native harness.*

The treatment under test is the **full** Papercusp system (D-004): the
coordination substrate (`coord:*`, `locks:*`, `work_items:*`, `messages:*`), the
multi-agent spine (scoper → architect → worker → validator → reviewer →
documenter → curator), and the blueprint layer. Giving the agents these tools is
**the independent variable, not a confounder to strip.**

## Impartiality commitments (non-negotiable)

The whole point is that a sophisticated third party cannot discount the result.
Our *internal* eval machinery (`iq-battery`, `hive-eval`, the `gym`) is excellent
for self-improvement but **worthless as impartial proof** — we author the tasks
*and* grade them. Impartiality requires outsourcing both ends (D-005):

1. **We don't author the tasks** — only established public third-party benchmarks.
2. **We don't grade** — the benchmark's *own* official hidden-test harness grades
   every arm with byte-identical machinery. Where possible we submit to a public
   leaderboard / the **Artificial Analysis Coding Agent Index** so a third party
   *re-runs* the result.
3. **Everything is reproducible** — we publish **rollout records** (the rollout is
   the unit of reproducibility), full configs, seeds, exact model + harness +
   grader versions, budgets, and raw grader output. Each run config is
   **pre-registered in git before the run** so we cannot tune-to-test.
4. **Firewall** — the `gym` never optimizes on a set this suite reports on
   (optimize-on and report-on sets are strictly disjoint; enforced in code + CI).

## The suite at a glance

| Tier                                      | Benchmark                                         | Why                                                            | Grader modality        |
| ----------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- | ---------------------- |
| Contamination-resistant core              | **SWE-bench Pro** (public split)                  | What OpenAI now points to; polyglot                            | M1 offline diff-batch  |
| Execution / DevOps core                   | **Terminal-Bench 2.0**                            | Real shells in real containers                                 | M2 online in-container |
| Long-horizon (coordination shines)        | **SWE-EVO**, **RoadmapBench**                     | Multi-file, decomposable — current single agents are weak here | M1                     |
| Freshness (strongest contamination lever) | **SWE-rebench**, **SWE-bench-Live**               | Auto-mined post-cutoff issues                                  | M1                     |
| Harness-isolation (air cover)             | **Harness-Bench**                                 | Purpose-built harness comparison; cite methodology now         | M2 (local sandbox)     |
| Footnote only (retired/saturated)         | SWE-bench Verified, HumanEval/MBPP, LiveCodeBench | Not headline material — see D-006                              | —                      |

The first families (D-003) are **SWE-bench Pro + Terminal-Bench 2.0** as the core,
plus **one long-horizon set** so the coordination advantage is actually exercised.

## How it's measured (in one breath)

* **Three baselines, run all three** — **A** internal ablation (causal proof),
  **B** native harness / Claude Code (the **headline**, strawman-proof), **C**
  best-of-N at matched budget (proves the tokens are justified).
* **Cost is the load-bearing control** — iso-budget cap on generation + a
  cost/accuracy Pareto with coordination overhead counted in *our* number +
  a match against best-of-N.
* **Statistics** — pass\@1 over **≥3 seeds with confidence intervals**, the *same*
  pass\@k protocol on every arm.

Full detail: **[Methodology →](/internal/docs/benchmarks/methodology)**.

## Reproduce it yourself

The suite is built to be re-run by anyone. The clone-and-run instructions, the
run-result schema, and the pre-registered-config layout live in the reproducer
README that ships with the suite: **`benchmarks/README.md`** at the repo root.

## Status & references

* **Plan:** `impartial-benchmark-suite-2026-06-15` (`plans:get { slug, harness: 'all' }`).
* **Feasibility + grader-interface spec (D-008):**
  `apps/operator/docs/external-bench-grader-feasibility-2026-06-15.md`.
* **Decisions:** D-001 (claim framing), D-002 (native harness is headline), D-003
  (first families), D-004 (treatment = full substrate), D-005 (we neither author
  nor grade), D-006 (Verified retired), D-007 (Evaluation dock-tab UI), D-008 (two
  grader modalities).
* **Key external sources:** OpenAI "Why we no longer evaluate SWE-bench Verified"
  (2026-02); Harness-Bench (arXiv 2605.27922); SWE-bench Pro (arXiv 2509.16941);
  Terminal-Bench 2.0; "AI Agents That Matter" (arXiv 2407.01502, cost-controlled
  Pareto); METR capability-elicitation; "Large Language Monkeys" (arXiv 2407.21787);
  Rollout Cards (arXiv 2605.12131); Artificial Analysis Coding Agent Index.
