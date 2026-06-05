/**
 * reflect-rules.test.ts — the work_item → plan-item reflection rules
 * (convert-at-pickup D-015, the read-back half).
 *
 * The rules are PURE (sync matcher over the tool event) — so this tests them
 * directly: registration on the engine, the stamp extraction, the state
 * mapping, and the exact plans:set-status args each rule renders, all from
 * synthetic events. The end-to-end flip is covered by the live E2E pass (the
 * reaction engine + plans:set-status are themselves tested elsewhere).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { reactionRulesFor } from '../events/registry';
import type { ToolInvocationEvent } from '../events/types';
import { reflectedStatus, stampOf } from './reflect-rules';

const STAMP = { plan_slug: 'demo-plan', item_id: 'P-007', harness_slug: 'papercup' };

function evt(tool: string, data: unknown, ok = true): ToolInvocationEvent {
  return {
    tool,
    args: {},
    result: { ok, data },
    ctx: { uiClientId: 'sess-T' } as never,
  };
}

function stamped(state: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    workItem: { id: 'WI-9', state, payload: { plan_item: STAMP } },
    ...extra,
  };
}

function ruleById(tool: string, id: string) {
  const rule = reactionRulesFor(tool).find((r) => r.id === id);
  expect(rule, `rule ${id} registered on ${tool}`).toBeTruthy();
  return rule!;
}

function renderArgs(rule: { args?: unknown }, e: ToolInvocationEvent): Record<string, unknown> {
  const a = rule.args;
  return typeof a === 'function' ? (a as (e: ToolInvocationEvent) => Record<string, unknown>)(e) : (a as Record<string, unknown>);
}

function fires(rule: { when?: unknown }, e: ToolInvocationEvent): boolean {
  const w = rule.when;
  return typeof w === 'function' ? (w as (e: ToolInvocationEvent) => boolean)(e) : true;
}

beforeAll(async () => {
  await import('./reflect-rules'); // registration-on-import
});

describe('stampOf — the payload back-link off a tool event', () => {
  it('extracts a valid stamp; rejects missing/partial/non-P-NNN stamps', () => {
    expect(stampOf(evt('t', stamped('open')))).toEqual(STAMP);
    expect(stampOf(evt('t', { ok: true, workItem: { id: 'WI-9' } }))).toBeNull();
    expect(stampOf(evt('t', { ok: true, workItem: { payload: { plan_item: { plan_slug: 'p' } } } }))).toBeNull();
    expect(
      stampOf(evt('t', { ok: true, workItem: { payload: { plan_item: { ...STAMP, item_id: 'EI-8' } } } })),
    ).toBeNull(); // plans:set-status only takes P-NNN — never render a doomed flip
    expect(stampOf(evt('t', undefined))).toBeNull();
  });
});

describe('reflectedStatus — work_item state → plan-item status', () => {
  it('maps terminal-success → done, terminal-drop → dropped, reopen → todo, in-flight → null', () => {
    expect(reflectedStatus('passed')).toBe('done');
    expect(reflectedStatus('resolved')).toBe('done');
    expect(reflectedStatus('done')).toBe('done');
    expect(reflectedStatus('deprecated')).toBe('dropped');
    expect(reflectedStatus('closed')).toBe('dropped');
    expect(reflectedStatus('dropped')).toBe('dropped');
    expect(reflectedStatus('todo')).toBe('todo');
    expect(reflectedStatus('open')).toBe('todo');
    expect(reflectedStatus('validating')).toBeNull();
    expect(reflectedStatus('failing')).toBeNull();
    expect(reflectedStatus(undefined)).toBeNull();
  });
});

describe('plan-item-reflect:complete', () => {
  it('fires plans:set-status → done with the stamp scope on a stamped completion', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    const e = evt('work_items:complete', stamped('open', { completion: { summary: 's' } }));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toMatchObject({
      harness: 'papercup',
      slug: 'demo-plan',
      itemId: 'P-007',
      status: 'done',
    });
  });

  it('does NOT fire without a completion record or without a stamp', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete');
    expect(fires(rule, evt('work_items:complete', stamped('open')))).toBe(false); // no completion
    expect(
      fires(rule, evt('work_items:complete', { ok: true, workItem: { id: 'WI-9' }, completion: {} })),
    ).toBe(false); // unconverted work_item — no stamp
  });
});

describe('plan-item-reflect:set-state', () => {
  it('fires on a mapped state; renders the mapped status', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');
    const e = evt('work_items:set_state', stamped('resolved'));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toMatchObject({ itemId: 'P-007', status: 'done' });

    const drop = evt('work_items:set_state', stamped('deprecated'));
    expect(renderArgs(rule, drop)).toMatchObject({ status: 'dropped' });

    const reopen = evt('work_items:set_state', stamped('open'));
    expect(renderArgs(rule, reopen)).toMatchObject({ status: 'todo' });
  });

  it('does NOT fire on an in-flight (unmapped) state', () => {
    const rule = ruleById('work_items:set_state', 'plan-item-reflect:set-state');
    expect(fires(rule, evt('work_items:set_state', stamped('validating')))).toBe(false);
  });
});

describe('lease release mirrors (complete / release also drop the plan-item lease)', () => {
  it('complete fires plan_items:release with the stamp scope', () => {
    const rule = ruleById('work_items:complete', 'plan-item-reflect:complete-releases-lease');
    const e = evt('work_items:complete', stamped('open', { completion: { summary: 's' } }));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toEqual({ harness: 'papercup', plan: 'demo-plan', item: 'P-007' });
    // No completion record / no stamp → no fire.
    expect(fires(rule, evt('work_items:complete', stamped('open')))).toBe(false);
    expect(fires(rule, evt('work_items:complete', { ok: true, workItem: { id: 'WI-9' }, completion: {} }))).toBe(false);
  });

  it('work_items:release fires plan_items:release for any stamped item (terminal or not)', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release-releases-lease');
    expect(fires(rule, evt('work_items:release', stamped('open')))).toBe(true);
    expect(fires(rule, evt('work_items:release', stamped('resolved')))).toBe(true);
    expect(fires(rule, evt('work_items:release', { ok: true, workItem: { id: 'WI-9' } }))).toBe(false);
    expect(renderArgs(rule, evt('work_items:release', stamped('open')))).toEqual({
      harness: 'papercup',
      plan: 'demo-plan',
      item: 'P-007',
    });
  });
});

describe('plan-item-reflect:release', () => {
  it('fires → todo when a non-terminal converted item is released', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release');
    const e = evt('work_items:release', stamped('open'));
    expect(fires(rule, e)).toBe(true);
    expect(renderArgs(rule, e)).toMatchObject({ itemId: 'P-007', status: 'todo' });
  });

  it('does NOT fire when the released item is already terminal (never resurrect a done item)', () => {
    const rule = ruleById('work_items:release', 'plan-item-reflect:release');
    expect(fires(rule, evt('work_items:release', stamped('resolved')))).toBe(false);
    expect(fires(rule, evt('work_items:release', stamped('passed')))).toBe(false);
  });
});
