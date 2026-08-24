/**
 * @vitest-environment jsdom
 *
 * Shared liveness primitives (P-004): the 3-state LivenessDot + the client-side
 * heartbeat→liveness derivation reused by the /coord dashboard and the /adv
 * Sessions roster.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  heartbeatToneFromTimestamp,
  LivenessDot,
  livenessForSessionState,
  livenessFromHeartbeat,
  normalizeSessionState,
} from '../presence-ui';

afterEach(cleanup);

describe('LivenessDot', () => {
  it('exposes the liveness state via data-liveness + aria-label', () => {
    const { getByRole, rerender } = render(<LivenessDot liveness="live" />);
    const dot = getByRole('img');
    expect(dot.getAttribute('data-liveness')).toBe('live');
    expect(dot.getAttribute('aria-label')).toBe('live agent');
    expect(dot.getAttribute('title')).toMatch(/Active/);

    rerender(<LivenessDot liveness="idle" />);
    expect(getByRole('img').getAttribute('data-liveness')).toBe('idle');

    rerender(<LivenessDot liveness="stale" />);
    expect(getByRole('img').getAttribute('data-liveness')).toBe('stale');
  });

  it('uses the authoritative session state when heartbeat freshness disagrees', () => {
    const { getByRole } = render(<LivenessDot liveness="live" sessionState="ended" />);
    const dot = getByRole('img');
    expect(dot.getAttribute('data-session-state')).toBe('ended');
    expect(dot.getAttribute('data-liveness')).toBe('stale');
    expect(dot.getAttribute('aria-label')).toBe('ended agent');
    expect(dot.getAttribute('title')).toBe('Session state: ended');
  });
});

describe('session-state liveness mapping', () => {
  it.each([
    ['live', 'live'],
    ['parked', 'idle'],
    ['draining', 'stale'],
    ['suspect', 'stale'],
    ['ended', 'stale'],
    ['recorded', 'idle'],
  ] as const)('maps %s to the %s dot tone', (state, expected) => {
    expect(livenessForSessionState(state)).toBe(expected);
  });

  it('rejects an unknown or missing roster state so heartbeat fallback remains possible', () => {
    expect(normalizeSessionState('future-state')).toBeNull();
    expect(normalizeSessionState(null)).toBeNull();
    expect(normalizeSessionState('parked')).toBe('parked');
  });
});

describe('livenessFromHeartbeat', () => {
  const now = 1_700_000_000_000;
  const iso = (ms: number): string => new Date(ms).toISOString();

  it('maps heartbeat age to live / idle / stale', () => {
    expect(livenessFromHeartbeat(iso(now - 10_000), now)).toBe('live'); // <1m
    expect(livenessFromHeartbeat(iso(now - 300_000), now)).toBe('idle'); // 5m
    expect(livenessFromHeartbeat(iso(now - 3_600_000), now)).toBe('stale'); // 1h
  });

  it('treats an unparseable heartbeat as stale', () => {
    expect(livenessFromHeartbeat('not-a-date', now)).toBe('stale');
  });

  it('is a compatibility alias for the explicitly named heartbeat tone', () => {
    expect(livenessFromHeartbeat(iso(now - 300_000), now)).toBe(
      heartbeatToneFromTimestamp(iso(now - 300_000), now),
    );
  });
});
