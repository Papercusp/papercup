/**
 * The extracted conversation wiring (goals-tab-improvement-2026-08-09 D-011).
 *
 * `buildSessionStreamUrl` is the reason this file exists. It carries the
 * EI-16982 archive fallback — an ended session's transcript is GC'd within ~2h
 * and the backend's rematerialize path only fires when `ended=1` is passed — and
 * that flag is invisible in every symptom: without it the transcript simply
 * comes back empty, which reads as "this agent said nothing" rather than as a
 * missing parameter. Now that a SECOND surface (the goal popup) depends on this
 * function, a silent regression here would take out both.
 */
import { describe, expect, it } from 'vitest';
import { buildSessionStreamUrl, deliveryFromSendResponse } from './use-owner-session-chat';

const LIVE = { source_kind: 'claude', session_id: 's-live', active: true, last_ts: null };
const ENDED = { source_kind: 'claude', session_id: 's-ended', active: false, last_ts: null };

/** Parse the query off a built url so assertions read as intent, not string-match. */
const q = (url: string | null) => new URLSearchParams((url ?? '').split('?')[1] ?? '');

describe('buildSessionStreamUrl', () => {
  it('returns null until there is both an owner and a resolved session', () => {
    // Null is the RENDERER GATE, not merely an empty value: useAgentThinkingStream
    // only skips its harness-run-log default url when streamUrl is truthy at call
    // time, so mounting the chat early opens a stream to the wrong thing.
    expect(buildSessionStreamUrl(null, LIVE)).toBeNull();
    expect(buildSessionStreamUrl('su-a', null)).toBeNull();
  });

  it('streams the resolved session for its owner', () => {
    const p = q(buildSessionStreamUrl('su-a', LIVE));
    expect(p.get('sessionId')).toBe('s-live');
    expect(p.get('owner')).toBe('su-a');
  });

  it('does NOT set ended=1 for a live session', () => {
    expect(q(buildSessionStreamUrl('su-a', LIVE)).get('ended')).toBeNull();
  });

  it('sets ended=1 for an ended session — the EI-16982 archive fallback', () => {
    expect(q(buildSessionStreamUrl('su-a', ENDED)).get('ended')).toBe('1');
  });

  it('sets ended=1 when a deep-link targets an EARLIER session, even though the resolved one is live', () => {
    /* The subtle case, and the one a naive `resolved.active` check gets wrong:
       `resolved` describes the LATEST session and says active:true, but the link
       points at an earlier rung of the respawn chain, which is by definition
       ended. Reading liveness off the wrong subject loses the fallback exactly
       when it is needed. */
    const p = q(buildSessionStreamUrl('su-a', LIVE, { focusSessionId: 's-older' }));
    expect(p.get('sessionId')).toBe('s-older');
    expect(p.get('ended')).toBe('1');
  });

  it('omits the search params entirely when there is no deep-link', () => {
    // Their absence is what leaves an ordinary open on the tail backfill.
    const p = q(buildSessionStreamUrl('su-a', LIVE));
    expect(p.get('find')).toBeNull();
    expect(p.get('anchorTs')).toBeNull();
  });

  it('passes the search deep-link through when there IS one', () => {
    const p = q(buildSessionStreamUrl('su-a', LIVE, { focusTerm: 'red gate', focusAnchorTs: '2026-08-09T00:00:00Z' }));
    expect(p.get('find')).toBe('red gate');
    expect(p.get('anchorTs')).toBe('2026-08-09T00:00:00Z');
  });
});

describe('deliveryFromSendResponse', () => {
  /* P-002: the point of this function is that it never over-claims. "Sent — the
     agent is woken if it's live" was false in two routine states, and both
     reported as unqualified success. */
  it('reports a real wake as woken, with the count', () => {
    expect(deliveryFromSendResponse({ results: [{ wake: { woken: 2 } }] })).toEqual({ kind: 'woken', count: 2 });
  });

  it('reports a MANUAL-mode staged wake as staged, never as woken', () => {
    expect(deliveryFromSendResponse({ results: [{ wake: { staged: true } }] })).toEqual({ kind: 'staged' });
    expect(deliveryFromSendResponse({ results: [{ staged: true }] })).toEqual({ kind: 'staged' });
  });

  it('reports an absent recipient rather than claiming delivery', () => {
    expect(deliveryFromSendResponse({ results: [{ recipient_absent: true }] })).toEqual({ kind: 'absent' });
  });

  it('degrades to queued — the weakest honest claim — when nothing characterises it', () => {
    expect(deliveryFromSendResponse({ results: [{}] })).toEqual({ kind: 'queued' });
    expect(deliveryFromSendResponse({})).toEqual({ kind: 'queued' });
    expect(deliveryFromSendResponse(null)).toEqual({ kind: 'queued' });
  });

  it('does not read woken:0 as a wake', () => {
    // The regression this guards: `if (wake.woken)` would be falsy here and fall
    // through correctly, but `typeof === 'number'` alone would not — 0 woken is
    // precisely the "reached nobody" case that must NOT read as success.
    expect(deliveryFromSendResponse({ results: [{ wake: { woken: 0 } }] })).toEqual({ kind: 'queued' });
  });
});
