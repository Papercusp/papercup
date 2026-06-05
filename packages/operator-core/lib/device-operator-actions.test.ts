/**
 * Tests for device-operator-actions — the PG-backed pause/resume sentinel
 * driven from the mobile WS bridge.
 *
 * (The operator-CARD verbs this file previously tested —
 * listPendingCards / dispatchCard / dismissCard / describeCard — were
 * retired with the scanner card stream: unify-agent-launches-as-blueprints
 * D-005. The pause/resume surface is what remains.)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(),
  writeOperatorState: vi.fn(),
}));
vi.mock('./sync-sse', () => ({
  notifySyncInvalidate: vi.fn().mockResolvedValue(undefined),
}));

import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { notifySyncInvalidate } from './sync-sse';
import { setPaused, setResumed, isPaused, getPauseInfo } from './device-operator-actions';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setPaused', () => {
  it('writes a paused row with who + when and invalidates the flag', async () => {
    await setPaused('mobile:device-1');
    expect(writeOperatorState).toHaveBeenCalledTimes(1);
    const [key, state] = (writeOperatorState as any).mock.calls[0];
    expect(key).toBe('operator_paused');
    expect(state.paused).toBe(true);
    expect(state.by).toBe('mobile:device-1');
    expect(typeof state.at).toBe('string');
    expect(() => new Date(state.at).toISOString()).not.toThrow();
    expect(notifySyncInvalidate).toHaveBeenCalledWith('operatorPauseFlag');
  });
});

describe('setResumed', () => {
  it('writes paused:false (keeps the row as audit trail) and invalidates', async () => {
    await setResumed();
    expect(writeOperatorState).toHaveBeenCalledWith('operator_paused', { paused: false });
    expect(notifySyncInvalidate).toHaveBeenCalledWith('operatorPauseFlag');
  });
});

describe('isPaused', () => {
  it('true only when the row says paused', async () => {
    (readOperatorState as any).mockResolvedValue({ paused: true, by: 'x' });
    await expect(isPaused()).resolves.toBe(true);
  });
  it('false when row is paused:false', async () => {
    (readOperatorState as any).mockResolvedValue({ paused: false });
    await expect(isPaused()).resolves.toBe(false);
  });
  it('false when no row exists', async () => {
    (readOperatorState as any).mockResolvedValue(null);
    await expect(isPaused()).resolves.toBe(false);
  });
});

describe('getPauseInfo', () => {
  it('returns who/when while paused', async () => {
    (readOperatorState as any).mockResolvedValue({ paused: true, by: 'ops', at: '2026-06-05T08:00:00.000Z' });
    await expect(getPauseInfo()).resolves.toEqual({ paused: true, by: 'ops', at: '2026-06-05T08:00:00.000Z' });
  });
  it('ignores stale by/at once resumed', async () => {
    (readOperatorState as any).mockResolvedValue({ paused: false, by: 'ops', at: '2026-06-05T08:00:00.000Z' });
    await expect(getPauseInfo()).resolves.toEqual({ paused: false });
  });
  it('handles a missing row', async () => {
    (readOperatorState as any).mockResolvedValue(null);
    await expect(getPauseInfo()).resolves.toEqual({ paused: false });
  });
});
