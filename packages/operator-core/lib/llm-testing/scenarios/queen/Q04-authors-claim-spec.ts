/**
 * QUEEN-Q04 — authors a per-bee claim SPEC (hybrid-bee-scheduler-work-stealing-2026-06-22 P-003).
 *
 * Question: when the Queen needs to steer a running bee toward a SCOPED lane (a plan + a file
 * scope), does she STEER PICKUP by authoring a per-bee claim SPEC via `scheduler:set_claim_spec`
 * (a scoped view + rank the bee then PULLS under) — the "centralize JUDGMENT, decentralize
 * PICKUP" model her prompt mandates — rather than micro-dispatching each item by hand
 * (a per-item `fleet:spawn` placement loop)?
 *
 * This is the QUEEN half of the P-003 adoption check (the bee half is bee/B01-pull-via-get-next).
 * The deterministic gates prove the WIRING (scheduler:set_claim_spec is in the coding blueprint
 * deps + named in queen.md — blueprint-prompt-dark-tools.test.ts); THIS is the behavioral leg:
 * does the prompt actually produce spec-authoring behavior on a steer-shaped turn?
 *
 * Load-bearing asserts (ERROR):
 *   - she calls `scheduler:set_claim_spec` for the bee, with a real spec object (a view/filter
 *     AND/OR a rank) — not an empty/garbage arg;
 *   - she does NOT fall back to per-item micro-dispatch (a `fleet:spawn` loop) to "place" the
 *     lane she should be expressing as a spec.
 */

import type { Scenario, ToolDispatchOverride } from '@papercusp/testing-shell/llm';
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';

import { SCHEDULER_USE_RUBRIC } from '../../rubrics/queen';
import { assertToolMatch, assertToolNotCalled } from '../su/_asserts';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

/** Deterministic steer world: a live bee on the frontier + a ready, scoped lane the Queen wants
 *  that bee to drain. The frontier is non-empty (so the steer is real), and set_claim_spec echoes
 *  a believable revision bump so the loop can progress. */
const STEER_WORLD: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    if (canon === 'fleet:assignments') {
      return {
        content: [
          {
            text: JSON.stringify({
              agents: [
                {
                  agent: 'bee-su-7f3a1',
                  presence: 'active',
                  workItems: ['WI-204'],
                  planItems: [],
                  heldPaths: ['packages/sync/'],
                },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'work_items:list') {
      return {
        content: [
          {
            text: JSON.stringify({
              items: [
                { id: 'WI-210', title: 'sync: SSE reconnect backoff', plan: 'data-sync-hardening-2026-06-20', paths: ['packages/sync/sse.ts'], state: 'todo', feature_order: 2 },
                { id: 'WI-211', title: 'sync: dedupe invalidation bursts', plan: 'data-sync-hardening-2026-06-20', paths: ['packages/sync/invalidate.ts'], state: 'todo', feature_order: 3 },
                { id: 'WI-212', title: 'ui: settings panel polish', plan: 'settings-polish-2026-06-19', paths: ['apps/operator-vite/Settings.tsx'], state: 'todo', feature_order: 5 },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'scheduler:set_claim_spec') {
      const a = (args ?? {}) as Record<string, unknown>;
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              beeId: a.beeId ?? 'bee-su-7f3a1',
              revision: 3,
              note: 'spec stored; the bee pulls under it on its next scheduler:get_next',
            }),
          },
        ],
      };
    }
    if (canon === 'scheduler:running') {
      return { content: [{ text: JSON.stringify({ runs: [{ bee: 'bee-su-7f3a1', item: 'WI-204', spec: 'sync-lane@2' }] }) }] };
    }
    if (canon === 'hive:declare-wake') return { content: [{ text: JSON.stringify({ ok: true }) }] };
    return PASS_THROUGH;
  },
};

export const QUEEN_Q04_AUTHORS_CLAIM_SPEC: Scenario = {
  id: 'queen-Q04-authors-claim-spec',
  version: 1,
  target: 'queen',
  transport: 'in-process',
  description:
    "The Hive operator relays the Queen a steer: bee bee-su-7f3a1 is healthy and draining work, and the Queen wants to focus it on the data-sync-hardening lane (the packages/sync/* work) over the unrelated settings-polish work — without hand-placing each item. Success: she authors a per-bee claim SPEC via scheduler:set_claim_spec scoping the bee's pull to that plan + path glob (filter) in a sensible rank, then lets the bee PULL under it — she does NOT micro-dispatch the lane item-by-item via fleet:spawn.",
  persona: {
    id: 'hive-steer-brief',
    description:
      'The Hive operator relaying a steer, terse and factual; answers follow-ups with frontier/bee facts only and never tells the Queen which tool to call or how to scope the spec.',
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
  goal: { kind: 'tool_fired', toolName: 'scheduler:set_claim_spec' },
  caps: { maxTurns: 2, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: STEER_WORLD,
  asserts: [
    assertToolMatch(
      (tc) => {
        if (canonical(tc.name) !== 'scheduler:set_claim_spec') return false;
        const input = (tc.input ?? {}) as Record<string, unknown>;
        const spec = input.spec as Record<string, unknown> | undefined;
        // A REAL spec: a bee id + a spec object carrying a view/filter and/or a rank — not empty.
        const beeOk = typeof input.beeId === 'string' && input.beeId.trim().length > 0;
        const specOk = !!spec && typeof spec === 'object' && ('view' in spec || 'filter' in spec || 'rank' in spec);
        return beeOk && specOk;
      },
      {
        name: 'authors-real-claim-spec',
        claim:
          'Expected the Queen to author a per-bee claim SPEC via scheduler:set_claim_spec — a beeId plus a spec object with a view/filter and/or a rank scoping the bee to the data-sync lane. No such call happened: she did not express the steer as a spec.',
        suggestion:
          "queen.md 'Steer the scheduler — author per-bee claim SPECS': turn the lane (plan + path glob) into the bee's spec via scheduler:set_claim_spec { beeId, spec: { view: { filter }, rank } } and let the bee pull under it.",
      },
    ),
    // She must NOT fall back to per-item micro-dispatch — the exact anti-pattern the spec replaces.
    assertToolNotCalled(['fleet:spawn'], {
      name: 'no-per-item-micro-dispatch',
      claim:
        'The Queen micro-dispatched via fleet:spawn instead of steering through a claim spec — the per-item placement loop the scheduler model (D-002: centralize JUDGMENT, decentralize PICKUP) is meant to replace.',
      suggestion:
        'Do NOT hand-place each lane item. Express the steer ONCE as a per-bee claim spec (scheduler:set_claim_spec); the bee pulls the scoped, ranked items itself via scheduler:get_next.',
    }),
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: SCHEDULER_USE_RUBRIC,
};

export default QUEEN_Q04_AUTHORS_CLAIM_SPEC;
