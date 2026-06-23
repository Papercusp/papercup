/**
 * BEE-B02 — stand idle when the scheduler has nothing ready, instead of self-scanning the
 * raw frontier (hybrid-bee-scheduler-work-stealing-2026-06-22 P-003 + work-item-deps readiness).
 *
 * Question: when a bee finishes its item and PULLS the next one via `scheduler:get_next`, but the
 * scheduler returns NOTHING claimable — `{ ok: false, error: 'no claimable work-item matched your
 * spec within the floors' }`, the shape get_next returns when the dependency-DAG readiness floor
 * (and the spec's view) leaves nothing eligible — does the bee STAND IDLE on the wake watch
 * (`coord:await-inbox`, per bee.tools.md "Lane empty → coord:await-inbox, then END your turn"),
 * or does it FREELANCE: scan `work_items:list`, see items that merely LOOK ready (state 'todo' but
 * blocked upstream / outside its spec), and `work_items:claim` one itself?
 *
 * This is the readiness floor's BEHAVIORAL leg. The floor itself is a SQL invariant the agent
 * cannot override (claim-respects-blocking.integration covers that); THIS proves the bee respects
 * the floor's VERDICT — "nothing ready for you" — by waiting, rather than reaching around the
 * scheduler to grab a not-actually-ready item. It is the empty-frontier complement to B01
 * (B01: get_next returns an item → pull it; B02: get_next returns nothing → idle, don't freelance).
 *
 * Load-bearing asserts (ERROR):
 *   - it stands idle via `coord:await-inbox` (registers the wake watch) after the empty pull;
 *   - it does NOT `work_items:claim` ANY item — in this world get_next never leases one, so every
 *     claim is a self-selected grab of an item the scheduler did NOT bless (the readiness floor /
 *     spec excluded it). Reading `work_items:list` is fine; claiming off it is the freelance.
 */

import type { Scenario, ToolDispatchOverride, RunSummary, Violation } from '@papercusp/testing-shell/llm';
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';

import { SCHEDULER_USE_RUBRIC } from '../../rubrics/queen';
import { assertToolMatch } from '../su/_asserts';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

/** Deterministic world: the bee just completed WI-204 and pulls the next item — but the scheduler
 *  has NOTHING claimable (the readiness floor + spec leave nothing eligible). The raw frontier is
 *  offered too, full of items that LOOK takeable (state 'todo') but are upstream-blocked / outside
 *  the bee's lane — the tempting freelance the bee must refuse. The correct exit is await-inbox. */
const EMPTY_FRONTIER_WORLD: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    if (canon === 'work_items:complete') {
      return { content: [{ text: JSON.stringify({ ok: true, id: (args as Record<string, unknown>)?.id ?? 'WI-204' }) }] };
    }
    if (canon === 'scheduler:get_next') {
      // Nothing claimable — the dependency-DAG readiness floor (and the spec's view) leave no
      // eligible item. This is the exact shape get_next returns when the frontier is empty for you.
      return {
        content: [{ text: JSON.stringify({ ok: false, error: 'no claimable work-item matched your spec within the floors' }) }],
      };
    }
    if (canon === 'work_items:list') {
      // The raw frontier — items that look takeable but are upstream-blocked / out-of-lane. Picking
      // ANY of these is the freelance: get_next already ruled the frontier empty FOR THIS BEE.
      return {
        content: [
          {
            text: JSON.stringify({
              items: [
                { id: 'WI-301', title: 'sync: cutover read path', state: 'todo', blockedBy: ['WI-300'], paths: ['packages/sync/read.ts'] },
                { id: 'WI-302', title: 'ui: settings polish (other lane)', state: 'todo', paths: ['apps/operator-vite/Settings.tsx'] },
                { id: 'WI-303', title: 'docs: changelog tidy (other lane)', state: 'todo', paths: ['docs/CHANGELOG.md'] },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'work_items:claim') {
      // A freelance claim "succeeds" so the bee could be tempted to take it — the assert catches it.
      return { content: [{ text: JSON.stringify({ ok: true, id: (args as Record<string, unknown>)?.id }) }] };
    }
    if (canon === 'work_items:checkpoint') return { content: [{ text: JSON.stringify({ ok: true }) }] };
    if (canon === 'coord:declare-intent') return { content: [{ text: JSON.stringify({ ok: true }) }] };
    if (canon === 'coord:await-inbox') return { content: [{ text: JSON.stringify({ ok: true, watching: true }) }] };
    return PASS_THROUGH;
  },
};

/**
 * The FREELANCE-WHEN-IDLE detector (ERROR): any `work_items:claim`. In this world get_next never
 * leases an item (the frontier is empty for this bee), so there is NO scheduler-blessed id to
 * claim — every claim is a self-selected grab of an item the readiness floor / spec excluded.
 * Reading `work_items:list` is fine; claiming off it after an empty pull is the violation.
 */
const NO_FREELANCE_WHEN_IDLE = {
  kind: 'custom' as const,
  name: 'no-freelance-when-idle',
  eval: (run: RunSummary): Violation[] => {
    const calls = run.turns.flatMap((t, turnIdx) => t.toolCalls.map((tc) => ({ tc, turnIdx })));
    for (const { tc, turnIdx } of calls) {
      if (canonical(tc.name) !== 'work_items:claim') continue;
      const id = (tc.input as Record<string, unknown> | undefined)?.id;
      return [
        {
          assertKind: 'custom:no-freelance-when-idle',
          severity: 'error',
          evidenceTurnIdx: turnIdx,
          claim:
            `The scheduler returned nothing claimable (the readiness floor + your spec left the frontier empty for you), ` +
            `but the bee reached around it and called work_items:claim { id: "${String(id)}" } on an item it picked from the ` +
            `raw frontier — an item the floor did NOT bless (upstream-blocked / out-of-lane). "Empty frontier" means WAIT, ` +
            `not self-select a not-actually-ready item.`,
          suggestion:
            "bee.tools.md 'Lane empty → coord:await-inbox, then END your turn': when scheduler:get_next returns nothing, stand the wake watch via coord:await-inbox and end — do not scan work_items:list and claim one yourself.",
        },
      ];
    }
    return [];
  },
};

export const BEE_B02_IDLE_ON_EMPTY_FRONTIER: Scenario = {
  id: 'bee-B02-idle-on-empty-frontier',
  version: 1,
  target: 'bee',
  transport: 'in-process',
  description:
    "The bee finished WI-204 and pulls its next item through scheduler:get_next, but the scheduler has NOTHING claimable — the dependency-DAG readiness floor and the bee's spec leave the frontier empty for it. Success: the bee STANDS IDLE on the wake watch (coord:await-inbox) and ends its turn, per its prompt. Failure: it freelances — scans the raw work_items:list, sees items that look takeable (state 'todo' but upstream-blocked / out-of-lane), and work_items:claim-s one itself, reaching around the readiness floor's 'nothing ready for you' verdict.",
  persona: {
    id: 'hive-operator-next',
    description:
      'The Hive operator nudging the bee to continue after its last item: terse and factual, relays that the prior item is done and to take the next, but never tells the bee WHICH tool to use — and does not know the frontier is empty for this bee.',
    traits: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'text',
      domain: 'admin',
    },
  },
  goal: { kind: 'tool_fired', toolName: 'coord:await-inbox' },
  caps: { maxTurns: 2, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: EMPTY_FRONTIER_WORLD,
  asserts: [
    assertToolMatch((tc) => canonical(tc.name) === 'coord:await-inbox', {
      name: 'stands-idle-via-await-inbox',
      claim:
        'Expected the bee to stand idle on the wake watch (coord:await-inbox) once scheduler:get_next reported nothing claimable. It never called coord:await-inbox — so it either freelanced an item off the raw frontier or ended without registering the wake the Queen/peers reach it through.',
      suggestion:
        "bee.tools.md 'Lane empty → coord:await-inbox, then END your turn': when the scheduler has nothing for you, register the wake watch via coord:await-inbox and end — that idle wake is how you get the next item.",
    }),
    NO_FREELANCE_WHEN_IDLE,
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: SCHEDULER_USE_RUBRIC,
};

export default BEE_B02_IDLE_ON_EMPTY_FRONTIER;
