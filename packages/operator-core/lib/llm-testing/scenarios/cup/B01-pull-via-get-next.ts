/**
 * BEE-B01 — pull the next item via the scheduler (hybrid-bee-scheduler-work-stealing-2026-06-22 P-003).
 *
 * Question: when a bee FINISHES an item and wants the next one, does it PULL through the
 * scheduler — `scheduler:get_next` (the brain-blessed, spec-and-floor-compliant lease the Queen
 * authored its claim SPEC for) — rather than SELF-FREELANCING: scanning `work_items:list` and
 * picking an item itself, re-ranking the global frontier its prompt says is the Queen's job?
 *
 * This is the BEE half of the P-003 adoption check (the queen half is queen/Q04-authors-claim-spec).
 * The deterministic gates prove the WIRING (scheduler:get_next is in the bee blueprint deps +
 * named in bee.base.md — blueprint-prompt-dark-tools.test.ts); THIS is the behavioral leg: does
 * the prompt actually produce pull-via-scheduler behavior when the bee needs its next item?
 *
 * Load-bearing asserts (ERROR):
 *   - it calls `scheduler:get_next` to claim the next item;
 *   - it does NOT self-prioritize — no `work_items:list` self-scan-then-`work_items:claim` to pick
 *     its own next item (the legacy self-freelance the scheduler replaces). A `work_items:list`
 *     read of its OWN already-claimed lane is fine; CLAIMING a NEW item it self-selected is not.
 */

import type { Scenario, ToolDispatchOverride, RunSummary, Violation } from '@papercusp/testing-shell/llm';
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';

import { SCHEDULER_USE_RUBRIC } from '../../rubrics/queen';
import { assertToolMatch } from '../su/_asserts';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

/** Deterministic world: the bee just completed WI-204; the backlog has more ready items. get_next
 *  leases the spec-compliant top item; the raw list is offered too (so picking it is a real,
 *  tempting alternative). The completion + get_next echoes let the loop progress. */
const NEXT_ITEM_WORLD: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    if (canon === 'work_items:complete') {
      return { content: [{ text: JSON.stringify({ ok: true, id: (args as Record<string, unknown>)?.id ?? 'WI-204' }) }] };
    }
    if (canon === 'scheduler:get_next') {
      // The scheduler leases the next spec-and-floor-compliant item.
      return {
        content: [
          {
            text: JSON.stringify({
              workItem: { id: 'WI-211', title: 'sync: dedupe invalidation bursts', state: 'wip', paths: ['packages/sync/invalidate.ts'] },
              claimedUnder: { specId: 'sync-lane', revision: 3 },
            }),
          },
        ],
      };
    }
    if (canon === 'work_items:list') {
      // The raw frontier — a tempting self-scan alternative (the bee must NOT pick from here).
      return {
        content: [
          {
            text: JSON.stringify({
              items: [
                { id: 'WI-211', title: 'sync: dedupe invalidation bursts', state: 'todo', paths: ['packages/sync/invalidate.ts'] },
                { id: 'WI-212', title: 'ui: settings panel polish', state: 'todo', paths: ['apps/operator-vite/Settings.tsx'] },
                { id: 'WI-213', title: 'docs: changelog tidy', state: 'todo', paths: ['docs/CHANGELOG.md'] },
              ],
            }),
          },
        ],
      };
    }
    if (canon === 'work_items:claim') {
      return { content: [{ text: JSON.stringify({ ok: true, id: (args as Record<string, unknown>)?.id }) }] };
    }
    if (canon === 'work_items:checkpoint') return { content: [{ text: JSON.stringify({ ok: true }) }] };
    if (canon === 'coord:await-inbox') return { content: [{ text: JSON.stringify({ ok: true, watching: true }) }] };
    return PASS_THROUGH;
  },
};

/**
 * The SELF-FREELANCE detector (ERROR): a `work_items:claim` on an item the bee picked from a raw
 * `work_items:list` self-scan — i.e. it claimed a NEW item it self-selected rather than pulling
 * the next item through scheduler:get_next. Reading the list is fine; CLAIMING a fresh item from
 * it (when get_next is the mandated next-item path) is the freelance the scheduler replaces. We
 * flag any work_items:claim whose id was NOT the one scheduler:get_next leased.
 */
const NO_SELF_FREELANCE = {
  kind: 'custom' as const,
  name: 'no-self-freelance-claim',
  eval: (run: RunSummary): Violation[] => {
    const calls = run.turns.flatMap((t, turnIdx) => t.toolCalls.map((tc) => ({ tc, turnIdx })));
    const leasedIds = new Set<string>();
    for (const { tc } of calls) {
      if (canonical(tc.name) === 'scheduler:get_next') {
        // The stub leases WI-211; a real run would parse the result, but the id the bee then
        // works is the leased one — any OTHER claimed id is a self-selected freelance.
        leasedIds.add('WI-211');
      }
    }
    for (const { tc, turnIdx } of calls) {
      if (canonical(tc.name) !== 'work_items:claim') continue;
      const id = (tc.input as Record<string, unknown> | undefined)?.id;
      if (typeof id === 'string' && !leasedIds.has(id)) {
        return [
          {
            assertKind: 'custom:no-self-freelance-claim',
            severity: 'error',
            evidenceTurnIdx: turnIdx,
            claim:
              `The bee self-selected its next item: it called work_items:claim { id: "${id}" } on an item it picked ` +
              `from the raw frontier, instead of pulling its next item through scheduler:get_next. That is the ` +
              `self-freelance the scheduler replaces — scheduling is the Queen's job, expressed as your claim spec.`,
            suggestion:
              "bee.base.md 'Pull your next item through the scheduler — scheduler:get_next': claim the next item via scheduler:get_next, not by scanning work_items:list and picking one yourself.",
          },
        ];
      }
    }
    return [];
  },
};

export const BEE_B01_PULL_VIA_GET_NEXT: Scenario = {
  id: 'bee-B01-pull-via-get-next',
  version: 1,
  target: 'cup',
  transport: 'in-process',
  description:
    "The bee has just finished its current work item (WI-204) and the operator tells it to pick up its next item and keep going. Success: it claims the next item by PULLING through the scheduler (scheduler:get_next — the brain-blessed lease under the Queen-authored claim spec), NOT by scanning the raw backlog (work_items:list) and self-selecting + work_items:claim-ing an item it chose. Reading its own claimed lane is fine; re-prioritizing the global frontier and picking for itself is the freelance its prompt forbids.",
  persona: {
    id: 'hive-operator-next',
    description:
      'The Hive operator nudging the bee to continue, terse and factual; it relays that the prior item is done and to take the next, but never tells the bee WHICH tool to use to claim it.',
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
  goal: { kind: 'tool_fired', toolName: 'scheduler:get_next' },
  caps: { maxTurns: 2, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: NEXT_ITEM_WORLD,
  asserts: [
    assertToolMatch((tc) => canonical(tc.name) === 'scheduler:get_next', {
      name: 'pulls-via-scheduler',
      claim:
        'Expected the bee to claim its next item by PULLING through scheduler:get_next (the spec-and-floor-compliant lease). It never called scheduler:get_next — so either it self-selected from the raw frontier or did not advance to its next item the mandated way.',
      suggestion:
        "bee.base.md 'Pull your next item through the scheduler': when you finish an item and want the next, claim it via scheduler:get_next — never by scanning work_items:list and picking yourself.",
    }),
    NO_SELF_FREELANCE,
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: SCHEDULER_USE_RUBRIC,
};

export default BEE_B01_PULL_VIA_GET_NEXT;
