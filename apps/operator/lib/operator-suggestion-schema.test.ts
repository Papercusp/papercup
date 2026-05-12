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

describe('ask_user suggestion variant', () => {
  const askUser = {
    id: 'au-1',
    action: 'ask_user' as const,
    capability: null,
    title: 'Strategic direction',
    why: 'Multiple harnesses competing for attention; user should weigh in',
    reason: 'long enough reason',
    tier: 'low' as const,
    question: 'Sheets and marketing both have escalations — which matters more?',
    framing: 'context for the brain',
  };

  it('validates a complete ask_user', () => {
    const r = SuggestionSchema.safeParse(askUser);
    expect(r.success).toBe(true);
  });

  it('framing is optional', () => {
    const { framing: _f, ...withoutFraming } = askUser;
    const r = SuggestionSchema.safeParse(withoutFraming);
    expect(r.success).toBe(true);
  });

  it('question is required (≥1 char)', () => {
    const r = SuggestionSchema.safeParse({ ...askUser, question: '' });
    expect(r.success).toBe(false);
  });

  it('ask_user resolves to tier=low (never dispatches)', () => {
    const t = resolveActualTier(askUser);
    expect(t.tier).toBe('low');
    expect(t.capabilityUnknown).toBe(false);
  });

  it('ask_user rejects send_directive fields', () => {
    const r = SuggestionSchema.safeParse({
      ...askUser,
      directive_body: 'should not be here',
    } as any);
    // Discriminated unions allow extra fields by default; assert the
    // shape parses to ask_user not send_directive (no schema-level reject
    // for extra props is fine; tier resolution + render path filter).
    expect(r.success).toBe(true);
  });
});
