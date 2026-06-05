import { describe, expect, it } from 'vitest';
import {
  SuggestionSchema,
  clampSuggestion,
  resolveActualTier,
  TITLE_MAX,
  WHY_MAX,
} from './operator-suggestion-schema';

describe('SuggestionSchema discriminated union', () => {
  it('accepts a valid send_directive', () => {
    const r = SuggestionSchema.safeParse({
      id: 'x', action: 'send_directive', capability: 'messages:write',
      title: 't', why: 'w', reason: 'good reason here', tier: 'medium',
      target_harness: 'foo', directive_kind: 'Directive',
      directive_subject: 's', directive_body: 'b',
    });
    expect(r.success).toBe(true);
  });

  it('rejects send_directive with capability=null', () => {
    const r = SuggestionSchema.safeParse({
      id: 'x', action: 'send_directive', capability: null,
      title: 't', why: 'w', reason: 'good reason here', tier: 'low',
      target_harness: 'foo', directive_kind: 'Directive',
      directive_subject: 's', directive_body: 'b',
    });
    expect(r.success).toBe(false);
  });

  it('rejects navigate with capability set', () => {
    const r = SuggestionSchema.safeParse({
      id: 'x', action: 'navigate', capability: 'messages:write',
      title: 't', why: 'w', reason: 'good reason here', tier: 'low',
      target_harness: 'foo', target_resource: '/x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects when reason is shorter than min', () => {
    const r = SuggestionSchema.safeParse({
      id: 'x', action: 'inform', capability: null,
      title: 't', why: 'w', reason: 'short', tier: 'low', body: 'b',
    });
    expect(r.success).toBe(false);
  });
});

describe('clampSuggestion', () => {
  it('truncates oversize title and surfaces the flag', () => {
    const c = clampSuggestion({
      id: 'x', action: 'inform', capability: null,
      title: 'a'.repeat(TITLE_MAX + 50), why: 'w', reason: 'good reason here',
      tier: 'low', body: 'b',
    });
    expect(c.s.title).toHaveLength(TITLE_MAX);
    expect(c.oversizedTitle).toBe(true);
  });

  it('truncates oversize why', () => {
    const c = clampSuggestion({
      id: 'x', action: 'inform', capability: null,
      title: 't', why: 'w'.repeat(WHY_MAX + 10), reason: 'good reason here',
      tier: 'low', body: 'b',
    });
    expect(c.s.why).toHaveLength(WHY_MAX);
    expect(c.oversizedWhy).toBe(true);
  });
});

describe('resolveActualTier', () => {
  const directive = (cap: string) => ({
    id: 'x', action: 'send_directive' as const, capability: cap as 'messages:write',
    title: 't', why: 'w', reason: 'good reason here', tier: 'low' as const,
    target_harness: 't', directive_kind: 'Directive' as const,
    directive_subject: 's', directive_body: 'b',
  });

  it('returns low for non-dispatching variants', () => {
    const t = resolveActualTier({
      id: 'x', action: 'inform', capability: null,
      title: 't', why: 'w', reason: 'good reason here', tier: 'low', body: 'b',
    });
    expect(t.tier).toBe('low');
  });

  it('substrate cap → substrate tier', () => {
    const t = resolveActualTier(directive('messages:write'));
    expect(t.tier).toBe('medium');
    expect(t.capabilityUnknown).toBe(false);
  });

  it('unknown cap with no plugin lookup → high (fail-safe)', () => {
    const t = resolveActualTier(directive('plugin:my:cap' as any));
    expect(t.tier).toBe('high');
    expect(t.capabilityUnknown).toBe(true);
  });

  it('unknown cap with plugin lookup result → uses plugin tier', () => {
    const t = resolveActualTier(directive('plugin:my:cap' as any), () => 'medium');
    expect(t.tier).toBe('medium');
    expect(t.capabilityUnknown).toBe(false);
  });
});

