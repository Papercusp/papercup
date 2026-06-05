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

  it('parses open verbs', () => {
    expect(parseOperatorIntent('operator open')).toEqual({ kind: 'open' });
    expect(parseOperatorIntent('operator show')).toEqual({ kind: 'open' });
  });

  it('parses scan verbs', () => {
    expect(parseOperatorIntent('operator scan')).toEqual({ kind: 'open-and-scan' });
    expect(parseOperatorIntent('operator status')).toEqual({ kind: 'open-and-scan' });
    expect(parseOperatorIntent("operator what's pending")).toEqual({ kind: 'open-and-scan' });
  });

  it('parses scan with query', () => {
    expect(parseOperatorIntent('operator scan tell me about auth')).toEqual({
      kind: 'open-and-scan',
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

  it('rejects unknown verbs', () => {
    expect(parseOperatorIntent('operator yodel')).toBeNull();
  });

  it('parses cross-workspace summary intent', () => {
    expect(parseOperatorIntent('operator across workspaces')).toEqual({ kind: 'across-workspaces' });
    expect(parseOperatorIntent('operator across workspace')).toEqual({ kind: 'across-workspaces' });
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
});
