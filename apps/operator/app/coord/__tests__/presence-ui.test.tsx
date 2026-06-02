/**
 * @vitest-environment jsdom
 *
 * Shared liveness primitives (P-004): the 3-state LivenessDot + the client-side
 * heartbeat→liveness derivation reused by the /coord dashboard and the /adv
 * Sessions roster.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LivenessDot, livenessFromHeartbeat } from '../presence-ui';

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
});
