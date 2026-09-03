/**
 * EI-10889 — the terminal state of a session is only ever visible in the TEXT of
 * its last assistant turn. These tests pin the classification of the real provider
 * strings observed in the wild (2026-07-13 audit), because the whole point of the
 * classifier is that a wedged session must not be reported as a settled one.
 */
import { describe, expect, it } from 'vitest';
import { classifySessionEnd, classifyWedgeText, isMachineModelErrorText, isWedged } from './session-end-reason';

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const minsAgo = (m: number) => NOW - m * 60_000;

describe('classifySessionEnd', () => {
  it('classifies the org auth wall as WEDGED (verbatim string from session c3a5178a)', () => {
    const r = classifySessionEnd({
      lastAssistantText:
        'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
      lastTsMs: minsAgo(120),
      nowMs: NOW,
    });
    expect(r.reason).toBe('auth_wall');
    expect(r.wedged).toBe(true);
    expect(r.evidence).toContain('disabled');
  });

  it('classifies an OMP 402 insufficient-credit response as WEDGED', () => {
    const r = classifySessionEnd({
      lastAssistantText: '402 Insufficient credits. This account never purchased credits.',
      lastTsMs: minsAgo(1),
      nowMs: NOW,
    });
    expect(r.reason).toBe('auth_wall');
    expect(r.wedged).toBe(true);
    expect(r.evidence).toContain('Insufficient credits');
  });

  it('classifies a usage/session limit as NOT wedged (it resets on its own)', () => {
    const r = classifySessionEnd({
      lastAssistantText: "You've hit your session limit · resets 4am (America/New_York)",
      lastTsMs: minsAgo(300),
      nowMs: NOW,
    });
    expect(r.reason).toBe('usage_limit');
    // The distinction that matters: an auth wall never recovers, a usage limit does.
    expect(r.wedged).toBe(false);
  });

  it('classifies a rejected model parameter as a model_error (session bf1881bc)', () => {
    const r = classifySessionEnd({
      lastAssistantText:
        "API Error: 400 This model does not support effort level 'xhigh'. Supported levels: high, low, max, medium.",
      lastTsMs: minsAgo(60),
      nowMs: NOW,
    });
    expect(r.reason).toBe('model_error');
    expect(r.wedged).toBe(true);
  });

  it('an error signature beats recency — a session dying on every wake is NOT "active"', () => {
    // This is the ordering bug the classifier exists to avoid: the auth-walled loop
    // was being woken every 60s, so its last turn was always SECONDS old. A
    // liveness-first classifier would have called it healthy while it did nothing.
    const r = classifySessionEnd({
      lastAssistantText: 'Your organization has disabled Claude subscription access for Claude Code',
      lastTsMs: minsAgo(0),
      nowMs: NOW,
    });
    expect(r.reason).toBe('auth_wall');
    expect(r.reason).not.toBe('active');
  });

  it('reports a recently-speaking healthy session as active', () => {
    const r = classifySessionEnd({
      lastAssistantText: 'Resolved EI-9942 with tests; reported to the leader.',
      lastTsMs: minsAgo(2),
      nowMs: NOW,
    });
    expect(r.reason).toBe('active');
    expect(r.wedged).toBe(false);
  });

  it('reports a quiet healthy session as settled', () => {
    const r = classifySessionEnd({
      lastAssistantText: 'Loop ended — no further self-wakes. Work is complete.',
      lastTsMs: minsAgo(600),
      nowMs: NOW,
    });
    expect(r.reason).toBe('settled');
  });

  it('an open owner wall outranks quiet-but-alive — the agent is parked on a human', () => {
    const r = classifySessionEnd({
      lastAssistantText: 'Wake settled — no delta. Still blocked on the capacity decision.',
      lastTsMs: minsAgo(600),
      nowMs: NOW,
      hasOpenWall: true,
    });
    expect(r.reason).toBe('awaiting_owner');
  });

  it('returns unknown (never a confident wrong label) when there is no closing turn', () => {
    const r = classifySessionEnd({ lastAssistantText: null, lastTsMs: null, nowMs: NOW });
    expect(r.reason).toBe('unknown');
    expect(r.evidence).toBeNull();
  });

  it('always carries evidence for a matched error so the label can be verified, not trusted', () => {
    const r = classifySessionEnd({
      lastAssistantText: 'API Error: 400 invalid_request_error — bad model',
      lastTsMs: minsAgo(5),
      nowMs: NOW,
    });
    expect(r.evidence).toBeTruthy();
    expect(r.evidence!.length).toBeLessThanOrEqual(200);
  });

  it('isWedged marks exactly the non-self-recovering reasons', () => {
    expect(isWedged('auth_wall')).toBe(true);
    expect(isWedged('model_error')).toBe(true);
    expect(isWedged('context_limit')).toBe(true);
    expect(isWedged('usage_limit')).toBe(false);
    expect(isWedged('settled')).toBe(false);
    expect(isWedged('active')).toBe(false);
    expect(isWedged('awaiting_owner')).toBe(false);
  });
});

/** EI-13818: the narrow, blind-scan-safe subset used to classify a just-exited
 *  subprocess's clean-exit (code 0) tail — see resume-turn-outcome.ts. */
describe('classifyWedgeText', () => {
  it('detects the exact session-limit signature from the EI-13818 incident', () => {
    const r = classifyWedgeText("You've hit your session limit · resets 5:40am (America/New_York)");
    expect(r?.reason).toBe('usage_limit');
    expect(r?.evidence).toContain('session limit');
  });

  it('detects an org auth wall', () => {
    const r = classifyWedgeText('Your organization has disabled Claude subscription access for Claude Code');
    expect(r?.reason).toBe('auth_wall');
  });

  it('detects an OMP 402 insufficient-credit provider wall', () => {
    const r = classifyWedgeText('402 Insufficient credits. This account never purchased credits.');
    expect(r?.reason).toBe('auth_wall');
    expect(r?.evidence).toContain('Insufficient credits');
  });

  it('does NOT trip on ordinary text that merely mentions rate limits (the model_error clause is excluded)', () => {
    expect(classifyWedgeText('discussed the rate limit fix')).toBeNull();
    expect(classifyWedgeText('API Error: 400 This model does not support effort level xhigh')).toBeNull();
  });

  it('does NOT trip on ordinary text mentioning a context window (context_limit excluded)', () => {
    expect(classifyWedgeText('fixed the bug where the context window exceeded expectations')).toBeNull();
  });

  it('returns null for empty/null/whitespace-only text', () => {
    expect(classifyWedgeText(null)).toBeNull();
    expect(classifyWedgeText(undefined)).toBeNull();
    expect(classifyWedgeText('   ')).toBeNull();
    expect(classifyWedgeText('all green; ending the turn.')).toBeNull();
  });
});

describe('isMachineModelErrorText (EI-22102700164999066)', () => {
  it('accepts MACHINE-emitted model-error signatures', () => {
    expect(isMachineModelErrorText("API Error: Request rejected (429) · This request would exceed your account's rate limit.")).toBe(true);
    expect(isMachineModelErrorText('API Error: 400 This model does not support effort level xhigh')).toBe(true);
    expect(isMachineModelErrorText('{"type":"invalid_request_error"}')).toBe(true);
  });

  it('REJECTS prose that merely mentions rate limits / 429s — the collision this split exists for', () => {
    expect(isMachineModelErrorText('discussed the rate limit fix')).toBe(false);
    expect(isMachineModelErrorText('why 429 handling matters')).toBe(false);
    expect(isMachineModelErrorText('the wake died on a rate limit with no escalation')).toBe(false);
    // "API Error:" only counts ANCHORED at the start — quoting one mid-sentence is prose.
    expect(isMachineModelErrorText('the turn ended with API Error: Request rejected (429)')).toBe(false);
  });

  it('returns false for empty/null/whitespace-only text', () => {
    expect(isMachineModelErrorText(null)).toBe(false);
    expect(isMachineModelErrorText(undefined)).toBe(false);
    expect(isMachineModelErrorText('   ')).toBe(false);
  });

  it('leaves classifySessionEnd UNCHANGED — the split narrows only its blind callers', () => {
    // The loose half still classifies for a session ALREADY KNOWN dead (session digests), which
    // is why the fix narrows the caller rather than the shared pattern.
    const loose = classifySessionEnd({
      lastAssistantText: 'discussed the rate limit fix',
      lastTsMs: 1_000,
      nowMs: 1_000,
      activeWithinMs: 0,
    });
    expect(loose.reason).toBe('model_error');
  });
});
