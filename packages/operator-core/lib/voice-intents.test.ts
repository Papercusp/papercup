import { describe, expect, it } from 'vitest';
import {
  parseOperatorIntent,
  isCapVoiceEligible,
  resolveApprove,
  type StandingCandidateLike,
} from './voice-intents';

describe('parseOperatorIntent', () => {
  it('returns null for non-prefixed utterances', () => {
    expect(parseOperatorIntent('approve the budget')).toBeNull();
    expect(parseOperatorIntent('open something')).toBeNull();
    expect(parseOperatorIntent('hello world')).toBeNull();
  });

  it('panel verbs were retired with the card panel (D-005) — open/show no longer parse', () => {
    expect(parseOperatorIntent('operator open')).toBeNull();
    expect(parseOperatorIntent('operator show')).toBeNull();
  });

  it('parses scan verbs', () => {
    expect(parseOperatorIntent('operator scan')).toEqual({ kind: 'scan' });
    expect(parseOperatorIntent('operator status')).toEqual({ kind: 'scan' });
    expect(parseOperatorIntent("operator what's pending")).toEqual({ kind: 'scan' });
  });

  it('parses scan with query', () => {
    expect(parseOperatorIntent('operator scan tell me about auth')).toEqual({
      kind: 'scan',
      query: 'tell me about auth',
    });
  });

  it('parses approve <slug>', () => {
    expect(parseOperatorIntent('operator approve foo')).toEqual({
      kind: 'approve', targetSlug: 'foo', capability: undefined,
    });
  });

  it('parses approve <slug> <cap-with-hyphens>', () => {
    expect(parseOperatorIntent('operator approve foo tasks-write')).toEqual({
      kind: 'approve', targetSlug: 'foo', capability: 'tasks:write',
    });
  });

  // Gap-4: cap spoken as separate words (STT splits "tasks write" not
  // "tasks-write"). parts[0]=slug, parts.slice(1) hyphen-joined then
  // colonized = cap. Three rest-tokens → a 2-segment cap.
  it('parses approve <slug> with cap as space-separated words', () => {
    expect(parseOperatorIntent('operator approve foo tasks write')).toEqual({
      kind: 'approve', targetSlug: 'foo', capability: 'tasks:write',
    });
  });

  // Gap-4: four rest-tokens collapse to a 3-segment cap (slug + 3 cap
  // words). 3 segments is voice-INELIGIBLE, so downstream resolveApprove
  // routes this to refuse-complex-cap (asserted in the resolveApprove
  // suite); here we just pin the parser's colonized shape.
  it('joins extra cap words into a 3-segment (complex) cap', () => {
    expect(parseOperatorIntent('operator approve foo tasks write extra')).toEqual({
      kind: 'approve', targetSlug: 'foo', capability: 'tasks:write:extra',
    });
    // …and the parsed cap is not voice-eligible, so it cannot be voice-approved.
    expect(isCapVoiceEligible('tasks:write:extra')).toBe(false);
  });

  it('rejects unknown verbs', () => {
    expect(parseOperatorIntent('operator yodel')).toBeNull();
  });

  it('across-workspaces was retired with the card panel (D-005) — no longer parses', () => {
    expect(parseOperatorIntent('operator across workspaces')).toBeNull();
    expect(parseOperatorIntent('operator across workspace')).toBeNull();
  });
});

describe('isCapVoiceEligible', () => {
  it('accepts simple 2-segment alphabetic caps', () => {
    expect(isCapVoiceEligible('tasks:write')).toBe(true);
    expect(isCapVoiceEligible('messages:write')).toBe(true);
    expect(isCapVoiceEligible('routines:write')).toBe(true);
  });

  it('rejects 3+ segments', () => {
    expect(isCapVoiceEligible('secrets:read:OPENAI_KEY')).toBe(false);
    expect(isCapVoiceEligible('data:read:papercup:foo')).toBe(false);
  });

  it('rejects underscores', () => {
    expect(isCapVoiceEligible('pending_events:write')).toBe(false);
  });

  it('rejects dots', () => {
    expect(isCapVoiceEligible('http:fetch:slack.com')).toBe(false);
  });

  it('rejects digits in segments', () => {
    expect(isCapVoiceEligible('tasks2:write')).toBe(false);
  });
});

describe('resolveApprove', () => {
  const c1: StandingCandidateLike = {
    capability: 'tasks:write', targetHarness: 'foo', firstShownAt: '2026-05-02T10:00:00Z',
  };
  const c2: StandingCandidateLike = {
    capability: 'messages:write', targetHarness: 'foo', firstShownAt: '2026-05-02T10:00:00Z',
  };
  const cUnshown: StandingCandidateLike = {
    capability: 'tasks:write', targetHarness: 'bar', firstShownAt: null,
  };
  const cComplex: StandingCandidateLike = {
    capability: 'secrets:read:OPENAI_KEY', targetHarness: 'baz', firstShownAt: '2026-05-02T10:00:00Z',
  };

  it('approves single eligible candidate', () => {
    const r = resolveApprove({ targetSlug: 'foo' }, [c1]);
    expect(r.action).toBe('approve');
    expect(r.capability).toBe('tasks:write');
  });

  it('refuses ambiguous (2 matching)', () => {
    const r = resolveApprove({ targetSlug: 'foo' }, [c1, c2]);
    expect(r.action).toBe('refuse-ambiguous');
    expect(r.options?.sort()).toEqual(['messages:write', 'tasks:write']);
  });

  it('explicit cap disambiguates', () => {
    const r = resolveApprove({ targetSlug: 'foo', capability: 'tasks:write' }, [c1, c2]);
    expect(r.action).toBe('approve');
    expect(r.capability).toBe('tasks:write');
  });

  it('refuses no-match for explicit cap that no candidate has', () => {
    const r = resolveApprove({ targetSlug: 'foo', capability: 'goals:write' }, [c1]);
    expect(r.action).toBe('refuse-no-match');
  });

  it('refuses unshown candidates (firstShownAt null gate)', () => {
    const r = resolveApprove({ targetSlug: 'bar' }, [cUnshown]);
    expect(r.action).toBe('refuse-no-match');
  });

  it('refuses complex caps even if single match', () => {
    const r = resolveApprove({ targetSlug: 'baz' }, [cComplex]);
    expect(r.action).toBe('refuse-complex-cap');
  });

  it('refuses complex explicit cap', () => {
    const r = resolveApprove(
      { targetSlug: 'foo', capability: 'pending_events:write' },
      [c1],
    );
    expect(r.action).toBe('refuse-complex-cap');
  });

  // ── Gap-5 (P1, authorization gate): the firstShownAt filter must apply
  // BEFORE the explicit-cap eligibility check. If that order ever flips, an
  // UNSHOWN or COMPLEX cap could slip through to a voice approve. These two
  // cases pin the gate from both directions; see the fault-injection note
  // in voice-intents.ts §resolveApprove.

  // (a) Shown candidate whose cap is complex (3 segments). It survives the
  //     firstShownAt filter (shown), then the cap-eligibility check rejects
  //     it → refuse-complex-cap. NEVER approve.
  it('Gap-5a: explicit complex cap on a SHOWN candidate → refuse-complex-cap (never approve)', () => {
    const shownComplex: StandingCandidateLike = {
      capability: 'secrets:read:KEY',
      targetHarness: 'foo',
      firstShownAt: '2026-05-02T10:00:00Z',
    };
    const r = resolveApprove(
      { targetSlug: 'foo', capability: 'secrets:read:KEY' },
      [shownComplex],
    );
    expect(r.action).toBe('refuse-complex-cap');
    expect(r.action).not.toBe('approve');
    expect(r.capability).toBeUndefined();
  });

  // (b) Candidate with an otherwise-eligible cap but firstShownAt:null. The
  //     unshown gate filters it out FIRST, so even an exact explicit cap
  //     cannot approve it → refuse-no-match. An unshown cap never approves.
  it('Gap-5b: explicit eligible cap on an UNSHOWN candidate → refuse-no-match (never approve)', () => {
    const unshownEligible: StandingCandidateLike = {
      capability: 'tasks:write',
      targetHarness: 'qux',
      firstShownAt: null,
    };
    const r = resolveApprove(
      { targetSlug: 'qux', capability: 'tasks:write' },
      [unshownEligible],
    );
    expect(r.action).toBe('refuse-no-match');
    expect(r.action).not.toBe('approve');
    expect(r.capability).toBeUndefined();
  });
});
