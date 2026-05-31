import { describe, expect, it, vi } from 'vitest';

vi.mock('./operator-dismissed-cache', () => ({
  isOnCooldown: async () => false,
}));

vi.mock('./operator-plugin-tier', () => ({
  resolvePluginAwareTierSync: () => null,
  resolvePluginAwareTier: async () => null,
}));

import { parseSuggestions, deriveAutoDispatch, enrich } from './operator-suggestion-parser';
import type { OperatorPreferences } from './operator-preferences';

const noPrefs: OperatorPreferences = { raw: '', standingApprovals: [] };

function block(obj: Record<string, unknown>): string {
  return `<suggestion>${JSON.stringify(obj)}</suggestion>`;
}

describe('parseSuggestions (v5 schema)', () => {
  it('extracts a well-formed send_directive block', async () => {
    const text = `prose ${block({
      id: 's1',
      action: 'send_directive',
      capability: 'messages:write',
      title: 'Run validator',
      why: 'Worker just finished — validator should pick up next.',
      reason: 'medium-tier dispatch with no standing approval',
      tier: 'medium',
      target_harness: 'foo',
      directive_kind: 'Directive',
      directive_subject: 'validate F-001',
      directive_body: 'Please validate F-001.',
    })} trailing`;
    const r = await parseSuggestions(text, noPrefs);
    expect(r.parseErrors).toEqual([]);
    expect(r.blocks).toHaveLength(1);
    const b = r.blocks[0].suggestion;
    expect(b.actualTier).toBe('medium');
    expect(b.auto_dispatch).toBe(false); // medium + no standing → ask
    expect(b.provenanceFlags).toEqual({});
  });

  it('extracts multiple variants', async () => {
    const text = [
      block({ id: 'a', action: 'inform', capability: null, title: 'A', why: 'B', reason: 'plenty of reason here', tier: 'low', body: 'note' }),
      block({ id: 'b', action: 'navigate', capability: null, title: 'C', why: 'D', reason: 'another good reason here', tier: 'low', target_harness: 'x', target_resource: '/x' }),
    ].join('\n');
    const r = await parseSuggestions(text, noPrefs);
    expect(r.blocks).toHaveLength(2);
  });

  it('forces high tier on unknown capability', async () => {
    const text = block({
      id: 'u',
      action: 'send_directive',
      capability: 'messages:write', // valid; we test unknown via cap field
      title: 'X',
      why: 'Y',
      reason: 'good reason here',
      tier: 'low',
      target_harness: 't',
      directive_kind: 'Directive',
      directive_subject: 's',
      directive_body: 'b',
    });
    const r = await parseSuggestions(text, noPrefs);
    expect(r.blocks[0].suggestion.actualTier).toBe('medium');
    expect(r.blocks[0].suggestion.provenanceFlags.tierMismatch).toBe(true);
  });

  it('records error on invalid JSON', async () => {
    const r = await parseSuggestions('<suggestion>{not valid}</suggestion>', noPrefs);
    expect(r.blocks).toHaveLength(0);
    expect(r.parseErrors[0]).toMatch(/JSON parse failed/);
  });

  it('records error on schema mismatch', async () => {
    const r = await parseSuggestions('<suggestion>{"title":"a"}</suggestion>', noPrefs);
    expect(r.blocks).toHaveLength(0);
    expect(r.parseErrors[0]).toMatch(/schema mismatch/);
  });

  it('rejects too-short reason', async () => {
    const r = await parseSuggestions(block({
      id: 'z', action: 'inform', capability: null,
      title: 'a', why: 'b', reason: 'short', tier: 'low', body: 'x',
    }), noPrefs);
    expect(r.blocks).toHaveLength(0);
    expect(r.parseErrors[0]).toMatch(/schema mismatch/);
  });

  it('truncates oversize title and flags it', async () => {
    const tooLong = 'x'.repeat(300);
    const r = await parseSuggestions(block({
      id: 'big', action: 'inform', capability: null,
      title: tooLong, why: 'why', reason: 'long enough reason', tier: 'low', body: 'b',
    }), noPrefs);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].suggestion.raw.title.length).toBe(160);
    expect(r.blocks[0].suggestion.provenanceFlags.oversizedTitle).toBe(true);
  });

  it('dedups within one scan by id', async () => {
    const dup = block({
      id: 'same', action: 'inform', capability: null,
      title: 'a', why: 'b', reason: 'good reason here', tier: 'low', body: 'x',
    });
    const r = await parseSuggestions(`${dup}\n${dup}`, noPrefs);
    expect(r.blocks).toHaveLength(1);
  });
});

describe('deriveAutoDispatch', () => {
  const inform = {
    id: 'x', action: 'inform' as const, capability: null,
    title: 't', why: 'w', reason: 'good reason here', tier: 'low' as const, body: 'b',
  };
  const directive = {
    id: 'd', action: 'send_directive' as const, capability: 'messages:write' as const,
    title: 't', why: 'w', reason: 'good reason here', tier: 'medium' as const,
    target_harness: 'foo', directive_kind: 'Directive' as const,
    directive_subject: 's', directive_body: 'b',
  };

  it('low → true', async () => {
    expect(deriveAutoDispatch(inform, 'low', noPrefs)).toBe(true);
  });
  it('high → false always', async () => {
    expect(deriveAutoDispatch(directive, 'high', noPrefs)).toBe(false);
  });
  it('medium + matching standing approval → true', async () => {
    const prefs: OperatorPreferences = {
      raw: '',
      standingApprovals: [{ capability: 'messages:write', targetHarness: 'foo', confirmedAt: '2026-05-01' }],
    };
    expect(deriveAutoDispatch(directive, 'medium', prefs)).toBe(true);
  });
  it('medium + no matching standing → false', async () => {
    expect(deriveAutoDispatch(directive, 'medium', noPrefs)).toBe(false);
  });
});

describe('enrich', () => {
  it('passes provenance untouched on a clean suggestion', async () => {
    const e = enrich({
      id: 'x', action: 'inform', capability: null,
      title: 't', why: 'w', reason: 'good reason here', tier: 'low', body: 'b',
    }, noPrefs);
    expect(e.provenanceFlags).toEqual({});
  });
});
