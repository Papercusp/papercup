import { describe, expect, it } from 'vitest';
import type { AutonomyCategory } from '../autonomy/categories';
import { ATTENTION_KIND_AUTHORITY, type AttentionKind, deriveAuthorization } from './types';

/** Minimal item shape {@link deriveAuthorization} needs. */
function item(kind: AttentionKind, needsHuman: boolean, category?: AutonomyCategory | null) {
  return { kind, needsHuman, category };
}

describe('deriveAuthorization (queue-authorization-redesign P-002)', () => {
  it('returns null/null for non-decision (¬needsHuman) items', () => {
    expect(deriveAuthorization(item('coord-escalation', false), false)).toEqual({
      whyGated: null,
      authorizer: null,
    });
    // armed state is irrelevant when the item isn't a decision
    expect(deriveAuthorization(item('plan-item', false), true)).toEqual({
      whyGated: null,
      authorizer: null,
    });
  });

  it('routes owner-authority dispositions to YOU (owner-only)', () => {
    // plan-item = ratify a needs-human item — owner's by right, non-protected category
    expect(deriveAuthorization(item('plan-item', true), true)).toEqual({
      whyGated: 'owner-only',
      authorizer: 'you',
    });
  });

  it('routes PROTECTED categories to YOU (protected), regardless of armed', () => {
    // standing-approval → system-control (PROTECTED)
    expect(deriveAuthorization(item('standing-approval', true), true)).toEqual({
      whyGated: 'protected',
      authorizer: 'you',
    });
    expect(deriveAuthorization(item('standing-approval', true), false)).toEqual({
      whyGated: 'protected',
      authorizer: 'you',
    });
  });

  it('routes system-authority, non-protected dispositions to the Queen', () => {
    // coord-escalation → escalations (system authority, not protected)
    expect(deriveAuthorization(item('coord-escalation', true), false)).toEqual({
      whyGated: 'unarmed',
      authorizer: 'queen-eligible',
    });
    expect(deriveAuthorization(item('coord-escalation', true), true)).toEqual({
      whyGated: 'above-ceiling',
      authorizer: 'queen-eligible',
    });
  });

  it('improvement (ideation-intake) is queen-eligible', () => {
    expect(deriveAuthorization(item('improvement', true), false)).toEqual({
      whyGated: 'unarmed',
      authorizer: 'queen-eligible',
    });
  });

  it('fail-safe: a needsHuman item with a null category needs YOU', () => {
    // smoke-fail maps to a null category; forcing needsHuman exercises the fail-safe
    expect(deriveAuthorization(item('smoke-fail', true, null), true)).toEqual({
      whyGated: 'owner-only',
      authorizer: 'you',
    });
  });

  it('falls back to the kind category when category is omitted', () => {
    // coord-message → inbox-triage (system, not protected)
    const viaFallback = deriveAuthorization(item('coord-message', true), true);
    const explicit = deriveAuthorization(item('coord-message', true, 'inbox-triage'), true);
    expect(viaFallback).toEqual(explicit);
    expect(viaFallback.authorizer).toBe('queen-eligible');
  });

  it('every attention kind has an authority mapping', () => {
    const kinds: AttentionKind[] = [
      'plan-item',
      'coord-escalation',
      'coord-message',
      'smoke-fail',
      'operator-report',
      'improvement',
      'standing-approval',
      'conversation',
      'scout-grade',
    ];
    for (const k of kinds) {
      expect(['owner', 'system']).toContain(ATTENTION_KIND_AUTHORITY[k]);
    }
  });
});
