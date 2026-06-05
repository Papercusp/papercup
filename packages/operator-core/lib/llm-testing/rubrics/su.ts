/**
 * SU engineer-collaborator rubric — su-scenario-suite-2026-05-31 P-002.
 *
 * The judge's secondary signal for the `su` target (the deterministic asserts
 * are the load-bearing check — D-002). Axes are tuned to the engineer
 * playbook's hard rules rather than the operator chat persona: tool selection,
 * convention adherence, scope discipline, groundedness, helpfulness.
 *
 * Mirrors the shape of `rubrics/operator.ts`. Bump the version on any anchor
 * change (it feeds the per-run identity hash).
 */

import type { JudgeRubric } from '@papercusp/testing-shell/llm';

export const SU_RUBRIC_VERSION = '1.0.0';

export const SU_RUBRIC: JudgeRubric = {
  version: SU_RUBRIC_VERSION,
  axes: [
    {
      id: 'helpfulness',
      description: 'Did the engineer move the user toward their actual goal?',
      anchors: {
        bad: 'Stalls, refuses without cause, or answers a different question than the one asked.',
        ideal: 'Advances the real task efficiently — names the next concrete action, no needless detours.',
      },
    },
    {
      id: 'toolSelection',
      description:
        'Did it pick the RIGHT tool for the request, with the right scope args?',
      anchors: {
        bad: "Wrong tool, a fabricated tool name, or stalling on a missing scope arg (e.g. treating `harness_required` as a dead-end instead of passing `harness:'all'`/a slug).",
        ideal: 'Minimal correct tool set; passes the required scope arg (harness/workspace); reaches for design-phase / docs before hand-rolling.',
      },
    },
    {
      id: 'conventionAdherence',
      description:
        "Did it follow the playbook's hard rules (Tauri-only app testing, push-not-poll, git-sync owns commits, no raw-SQL on schema-canonical tables, nuqs/sync/defineTool seams)?",
      anchors: {
        bad: 'Proposes a banned path — browse :3055/:3070, a polling loop by default, a manual git commit/push, raw SQL to mutate harness state, an invented write verb.',
        ideal: 'Routes through the blessed path — Tauri shell + testing docs, SSE/IPC push, leave work in the tree for git-sync, pipeline / messages:send for work-item state.',
      },
    },
    {
      id: 'groundedness',
      description: 'Are factual claims backed by a tool call / docs, not invented?',
      anchors: {
        bad: 'Asserts harness/feature/file contents (or tool names) that no tool was called to verify; speculates from training memory.',
        ideal: 'Cites a tool result or the docs; reads before answering "how does X work"; says "let me check" rather than guessing.',
      },
    },
    {
      id: 'scopeDiscipline',
      description: 'Did it stay in scope and surface (not silently drop) deferrals?',
      anchors: {
        bad: 'Silently re-scopes, balloons the task beyond the ask, or quietly defers in-scope work.',
        ideal: 'Tight scope; if something must be deferred it is surfaced explicitly, not dropped.',
      },
    },
  ],
  criticality: 'normal',
};
