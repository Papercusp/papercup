import { describe, it, expect } from 'vitest';
import { decideGitSyncEscalation, oversizedKey, PUSH_FAILURE_ESCALATION_TICKS } from './git-sync-escalation';
import type { ScopedOversized } from './run-git-sync';

const big: ScopedOversized = { scope: 'superproject', path: 'apps/tui/target/huge.rlib', sizeBytes: 200 * 1048576 };

const base = {
  status: 'synced' as const,
  consecutiveErrorTicks: 0,
  errors: [],
  oversized: [],
  prevOversizedKeys: [],
};

describe('decideGitSyncEscalation (EI-18)', () => {
  it('clean synced pass → clear, no escalation, no broadcast', () => {
    const d = decideGitSyncEscalation(base);
    expect(d).toEqual({ escalate: false, reasons: [], clear: true, broadcast: null });
  });

  it('clean "nothing" pass → clear too', () => {
    const d = decideGitSyncEscalation({ ...base, status: 'nothing' });
    expect(d.clear).toBe(true);
    expect(d.escalate).toBe(false);
  });

  it('errors BELOW the threshold → no escalation, no broadcast, no clear (condition may still be brewing)', () => {
    for (const ticks of [1, PUSH_FAILURE_ESCALATION_TICKS - 1]) {
      const d = decideGitSyncEscalation({
        ...base,
        status: 'error',
        consecutiveErrorTicks: ticks,
        errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
      });
      expect(d.escalate).toBe(false);
      expect(d.broadcast).toBeNull();
      expect(d.clear).toBe(false);
    }
  });

  it('errors AT the threshold → escalate + broadcast naming the failure', () => {
    const d = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{ scope: 'superproject', message: 'push failed: HTTP 500\nsend-pack: disconnect' }],
    });
    expect(d.escalate).toBe(true);
    expect(d.reasons).toEqual(['push-failure']);
    expect(d.broadcast).toContain(`FAILED ${PUSH_FAILURE_ESCALATION_TICKS} consecutive ticks`);
    expect(d.broadcast).toContain('HTTP 500');
    expect(d.broadcast).not.toContain('send-pack'); // first line only
  });

  it('errors ABOVE the threshold → still escalates (row refresh) but broadcast only fired at the transition', () => {
    const d = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS + 2,
      errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
    });
    expect(d.escalate).toBe(true);
    expect(d.broadcast).toBeNull();
  });

  it('a NEW oversized file → escalate + broadcast listing it', () => {
    const d = decideGitSyncEscalation({ ...base, oversized: [big] });
    expect(d.escalate).toBe(true);
    expect(d.reasons).toEqual(['oversized-blobs']);
    expect(d.clear).toBe(false); // the unpushable file still sits in the tree
    expect(d.broadcast).toContain('apps/tui/target/huge.rlib');
    expect(d.broadcast).toContain('200.0MB');
  });

  it('a PERSISTING oversized file (same key as last tick) → escalate, but NO repeat broadcast', () => {
    const d = decideGitSyncEscalation({ ...base, oversized: [big], prevOversizedKeys: [oversizedKey(big)] });
    expect(d.escalate).toBe(true);
    expect(d.broadcast).toBeNull();
  });

  it('threshold + new oversized together → both reasons, one combined broadcast', () => {
    const d = decideGitSyncEscalation({
      ...base,
      status: 'error',
      consecutiveErrorTicks: PUSH_FAILURE_ESCALATION_TICKS,
      errors: [{ scope: 'superproject', message: 'push failed: HTTP 500' }],
      oversized: [big],
    });
    expect(d.reasons).toEqual(['push-failure', 'oversized-blobs']);
    expect(d.broadcast).toContain('consecutive ticks');
    expect(d.broadcast).toContain('huge.rlib');
  });

  it('a conflict tick neither escalates the error kind nor clears it (the conflict path owns that tick)', () => {
    const d = decideGitSyncEscalation({ ...base, status: 'conflict' });
    expect(d.escalate).toBe(false);
    expect(d.clear).toBe(false);
  });

  it('oversizedKey is scope-qualified (same path in two repos = two keys)', () => {
    expect(oversizedKey(big)).toBe('superproject:apps/tui/target/huge.rlib');
    expect(oversizedKey({ ...big, scope: 'libs/sub' })).not.toBe(oversizedKey(big));
  });
});
