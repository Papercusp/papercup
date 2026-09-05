import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import { describe, expect, it } from 'vitest';

import {
  S27_DISPATCH_WORLD,
  SU_S27_WOKE_TO_DISPATCH_CLAIMS,
} from './S27-woke-to-dispatch-claims';

async function call(name: string, args: unknown = {}): Promise<Record<string, any>> {
  const result = await S27_DISPATCH_WORLD.override(name, args);
  if (result === PASS_THROUGH) throw new Error(`${name} unexpectedly passed through`);
  const text = (result as { content: Array<{ text?: string }> }).content[0]?.text;
  if (typeof text !== 'string') throw new Error(`${name} did not return text content`);
  return JSON.parse(text) as Record<string, any>;
}

describe('SU-S27 directed-dispatch world', () => {
  const planSlug = 'fleet-dispatch-wake-clarity-2026-06-22';
  const planItems = ['P-001', 'P-002', 'P-003', 'P-004'];
  const workItems = ['WI-501', 'WI-502', 'WI-503', 'WI-504'];

  it('bumps the scenario after replacing the contradictory revision-1 world', () => {
    expect(SU_S27_WOKE_TO_DISPATCH_CLAIMS.version).toBe(2);
  });

  it('exposes every dispatched item and the exact plan identity at orientation', async () => {
    const result = await call('mcp__agentmcp__coord:orient', { intent: 'pick up the dispatch' });

    expect(result.claimable.map((item: any) => item.id)).toEqual(workItems);
    expect(result.claimable.map((item: any) => item.payload.plan_item.item_id)).toEqual(planItems);
    expect(result.claimable.every((item: any) => item.payload.plan_item.plan_slug === planSlug)).toBe(true);
    expect(result.inbox.recent[0]).toMatchObject({
      kind: 'dispatch',
      planSlug,
      planItems,
    });
  });

  it('keeps plan, assigned-plan-item, and work-item reads consistent', async () => {
    const [plan, assigned, listed] = await Promise.all([
      call('plans:get', { slug: planSlug, harness: 'papercusp' }),
      call('plan_items:my_items'),
      call('work_items:list'),
    ]);

    expect(plan.slug).toBe(planSlug);
    expect(plan.items.map((item: any) => item.id)).toEqual(planItems);
    expect(assigned.items.map((item: any) => item.item)).toEqual(planItems);
    expect(listed.items.map((item: any) => item.id)).toEqual(workItems);
  });

  it('returns argument-aware confirmations for both direct and plan claims', async () => {
    const direct = await call('work_items:claim', { row: 'WI-503' });
    const plan = await call('plans:set-status', {
      slug: planSlug,
      itemId: 'P-004',
      status: 'wip',
    });
    const declared = await call('coord:declare-intent', {
      intent: 'claim the dispatched lane',
      current_plan_slug: planSlug,
      items: planItems,
    });

    expect(direct).toMatchObject({ id: 'WI-503', workItem: { id: 'WI-503', state: 'wip' } });
    expect(plan).toMatchObject({ itemId: 'P-004', oldStatus: 'todo', newStatus: 'wip' });
    expect(declared.claims.claimed).toEqual(planItems);
  });

  it('passes unrelated tools through', async () => {
    expect(await S27_DISPATCH_WORLD.override('docs:search', { query: 'x' })).toBe(PASS_THROUGH);
  });
});
