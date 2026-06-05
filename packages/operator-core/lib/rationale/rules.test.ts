/**
 * The rationale-projection event-maintenance rules register correctly and derive
 * the right `rationale:reproject` args from each trigger (docs-and-memory-as-
 * projections-2026-06-05 D-003). Pure: asserts the rule objects in the registry; it
 * does not fire dispatch.
 */
import { describe, it, expect } from 'vitest';
import type { ToolInvocationEvent } from '../events';
import { listReactionRules } from '../events';
import './rules'; // self-registers

function ruleById(id: string) {
  return listReactionRules().find((r) => r.id === id);
}

function ev(tool: string, args: unknown): ToolInvocationEvent {
  return { tool, args, result: { ok: true }, ctx: {} as ToolInvocationEvent['ctx'] };
}

function fireArgs(rule: ReturnType<typeof ruleById>, e: ToolInvocationEvent) {
  const a = rule!.args;
  return typeof a === 'function' ? a(e) : a;
}

describe('rationale rules', () => {
  it('registers all four maintenance rules firing rationale:reproject', () => {
    for (const id of [
      'rationale:plan-decision',
      'rationale:topic-tag',
      'rationale:work-item-tag',
      'rationale:work-item-state',
    ]) {
      const r = ruleById(id);
      expect(r, id).toBeTruthy();
      expect(r!.fire).toBe('rationale:reproject');
      expect(r!.onlyOnSuccess).toBe(true);
    }
  });

  it('plans:add-decision → reproject the plan (passing harness through)', () => {
    const r = ruleById('rationale:plan-decision')!;
    expect(r.on).toBe('plans:add-decision');
    const e = ev('plans:add-decision', { slug: 'my-plan', harness: 'papercup', title: 't', body: 'b' });
    expect((r.when as (x: ToolInvocationEvent) => boolean)(e)).toBe(true);
    expect(fireArgs(r, e)).toEqual({ kind: 'plan', id: 'my-plan', harness: 'papercup' });
  });

  it('plans:add-decision without a slug does not match', () => {
    const r = ruleById('rationale:plan-decision')!;
    expect((r.when as (x: ToolInvocationEvent) => boolean)(ev('plans:add-decision', {}))).toBe(false);
  });

  it('topics:tag → reproject the tagged object', () => {
    const r = ruleById('rationale:topic-tag')!;
    expect(r.on).toBe('topics:tag');
    const e = ev('topics:tag', { object_kind: 'plan', object_ref: 'my-plan', topic: 'coord' });
    expect((r.when as (x: ToolInvocationEvent) => boolean)(e)).toBe(true);
    expect(fireArgs(r, e)).toEqual({ kind: 'tagged', objectKind: 'plan', objectRef: 'my-plan' });
  });

  it('work_items:tag → reproject the work-item', () => {
    const r = ruleById('rationale:work-item-tag')!;
    expect(r.on).toBe('work_items:tag');
    const e = ev('work_items:tag', { id: 'WI-42', topic: 'coord', harness: 'papercup' });
    expect(fireArgs(r, e)).toEqual({ kind: 'work_item', id: 'WI-42', harness: 'papercup' });
  });

  it('work_items:set_state and :complete both → reproject the work-item', () => {
    const r = ruleById('rationale:work-item-state')!;
    expect(r.on).toEqual(['work_items:set_state', 'work_items:complete']);
    const e = ev('work_items:set_state', { id: 'WI-42', state: 'resolved' });
    expect(fireArgs(r, e)).toEqual({ kind: 'work_item', id: 'WI-42' });
  });
});
