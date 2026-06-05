/**
 * Unit tests for the emits → ReactionRule desugar
 * (coord-lifecycle-automation-2026-06-04 D-002).
 *
 * Verifies the "sugar, never a parallel path" boundary: an `emits` entry maps
 * 1:1 to a rule whose `on` is the declaring tool, whose `args` is the entry's
 * `render`, and whose defaults (durable / onlyOnSuccess) match the engine
 * contract.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  collectToolEmits,
  _resetCollectedToolEmitsForTests,
  type ToolEmitSpec,
  type ToolEventLike,
} from '@papercusp/tooldef';
import {
  emitsEntryToRule,
  emitRuleId,
  collectEmitRules,
  registerEmitRules,
  type ReactionRule,
} from './emits-desugar';

const sampleEvent: ToolEventLike = {
  tool: 'work_items:complete',
  args: { id: 'F-1', completion: { workItem: 'F-1', summary: 'done' } },
  result: { ok: true, data: {} },
  ctx: { harnessSlug: 'papercup', role: 'worker' },
};

describe('emitsEntryToRule', () => {
  it('maps an emits entry to a ReactionRule 1:1', () => {
    const render = (e: ToolEventLike) => ({ category: 'completion', summary: String(e.tool) });
    const spec: ToolEmitSpec = { fire: 'coord:emit', render };
    const rule = emitsEntryToRule('work_items:complete', spec, 0);

    expect(rule.id).toBe('emits:work_items:complete#0');
    expect(rule.on).toBe('work_items:complete');
    expect(rule.fire).toBe('coord:emit');
    expect(rule.args).toBe(render); // render IS the arg-template (not re-wrapped)
    expect(rule.mode).toBe('durable'); // default
    expect(rule.onlyOnSuccess).toBe(true); // default
    expect(rule.source).toBe('emits:work_items:complete');
  });

  it('honours explicit id, mode, onlyOnSuccess, when', () => {
    const when = (e: ToolEventLike) => e.result.ok;
    const spec: ToolEmitSpec = {
      fire: 'coord:emit',
      render: () => ({}),
      id: 'window-open',
      mode: 'sync',
      onlyOnSuccess: false,
      when,
    };
    const rule = emitsEntryToRule('locks:acquire', spec, 3);
    expect(rule.id).toBe('emits:locks:acquire#window-open');
    expect(rule.mode).toBe('sync');
    expect(rule.onlyOnSuccess).toBe(false);
    expect(rule.when).toBe(when);
  });

  it('omits `when` entirely when not provided (engine default = always)', () => {
    const rule = emitsEntryToRule('t', { fire: 'f', render: () => ({}) }, 0);
    expect('when' in rule).toBe(false);
  });

  it('the rule args fn, when invoked, IS the render output', () => {
    const spec: ToolEmitSpec = {
      fire: 'coord:emit',
      render: (e) => ({ summary: `did ${e.tool}` }),
    };
    const rule = emitsEntryToRule('x:y', spec, 0);
    const args = (rule.args as (e: ToolEventLike) => Record<string, unknown>)(sampleEvent);
    expect(args).toEqual({ summary: 'did work_items:complete' });
  });

  it('emitRuleId is stable + index-derived by default', () => {
    expect(emitRuleId('a:b', { fire: 'f', render: () => ({}) }, 2)).toBe('emits:a:b#2');
    expect(emitRuleId('a:b', { fire: 'f', render: () => ({}), id: 'k' }, 2)).toBe('emits:a:b#k');
  });
});

describe('collectEmitRules / registerEmitRules (the at-load desugar)', () => {
  beforeEach(() => _resetCollectedToolEmitsForTests());

  it('desugars every collected tool emit into a rule', () => {
    collectToolEmits('work_items:complete', [{ fire: 'coord:emit', render: () => ({}) }]);
    collectToolEmits('work_items:claim', [{ fire: 'coord:emit', render: () => ({}) }]);
    const rules = collectEmitRules();
    expect(rules.map((r) => r.on)).toEqual(['work_items:complete', 'work_items:claim']);
    expect(rules.every((r) => r.fire === 'coord:emit')).toBe(true);
  });

  it('a tool with multiple emits yields a rule per entry, distinctly id-d', () => {
    collectToolEmits('locks:acquire', [
      { fire: 'coord:emit', render: () => ({}), id: 'open' },
      { fire: 'coord:emit', render: () => ({}), id: 'done' },
    ]);
    const rules = collectEmitRules();
    expect(rules.map((r) => r.id)).toEqual([
      'emits:locks:acquire#open',
      'emits:locks:acquire#done',
    ]);
  });

  it('registerEmitRules fires the injected register for each rule + returns the count', () => {
    collectToolEmits('a:b', [{ fire: 'coord:emit', render: () => ({}) }]);
    collectToolEmits('c:d', [{ fire: 'coord:emit', render: () => ({}) }]);
    const registered: ReactionRule[] = [];
    const count = registerEmitRules((r) => registered.push(r));
    expect(count).toBe(2);
    expect(registered).toHaveLength(2);
    expect(registered.map((r) => r.id)).toEqual(['emits:a:b#0', 'emits:c:d#0']);
  });

  it('no collected emits ⇒ zero rules, register never called', () => {
    let calls = 0;
    expect(registerEmitRules(() => calls++)).toBe(0);
    expect(calls).toBe(0);
  });
});
