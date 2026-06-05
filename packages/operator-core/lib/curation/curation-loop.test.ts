import { describe, it, expect } from 'vitest';
import {
  runCurationTick,
  formatSignalLine,
  formatSurfaceMessage,
  formatBatchDigest,
  nextInterval,
  shouldRunTick,
  canEmitDigestNow,
  BASE_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  DIGEST_MIN_GAP_SECONDS,
  DIGEST_BURST_THRESHOLD,
  type CurationDeps,
} from './curation-loop';
import type { FleetReaders } from './fleet-signals';
import type { SurfacedEntry } from './curation-log';
import type { ClassifiedSignal } from './salience-policy';

const EMPTY_READERS: FleetReaders = {
  escalations: async () => [],
  blocked: async () => [],
  decisions: async () => [],
  completions: async () => [],
  progress: async () => [],
};

function harness(over: Partial<FleetReaders>, alreadySurfaced = new Set<string>()) {
  const surfaced: string[] = [];
  const recorded: SurfacedEntry[] = [];
  const deps: CurationDeps = {
    readers: { ...EMPTY_READERS, ...over },
    loadSurfaced: async () => alreadySurfaced,
    recordSurfaced: async (entries) => {
      recorded.push(...entries);
    },
    surface: async (text) => {
      surfaced.push(text);
    },
  };
  return { deps, surfaced, recorded };
}

describe('runCurationTick — surfacing', () => {
  it('surfaces an urgent escalation as one message and records it', async () => {
    const { deps, surfaced, recorded } = harness({
      escalations: async () => [{ msgId: 'e1', severity: 'blocker', summary: 'build wedged', ts: '2026-06-04T03:00:00Z' }],
    });
    const result = await runCurationTick(deps);
    expect(result.hasUrgent).toBe(true);
    expect(result.surfacedCount).toBe(1);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toMatch(/Blocked|build wedged/);
    expect(surfaced[0]).toMatch(/drill in/);
    expect(recorded.map((r) => r.id)).toContain('escalation:e1');
  });

  it('does NOT surface a signal already surfaced (idempotency)', async () => {
    const { deps, surfaced } = harness(
      { escalations: async () => [{ msgId: 'e1', severity: 'blocker', summary: 'x', ts: '2026-06-04T03:00:00Z' }] },
      new Set(['escalation:e1']),
    );
    const result = await runCurationTick(deps);
    expect(result.surfacedCount).toBe(0);
    expect(surfaced).toHaveLength(0);
  });

  it('batches routine progress into ONE digest when allowed', async () => {
    const { deps, surfaced, recorded } = harness({
      progress: async () => [
        { id: 'p1', title: 'F-1 → validating', ts: '2026-06-04T03:00:00Z' },
        { id: 'p2', title: 'F-2 → passed', ts: '2026-06-04T03:01:00Z' },
      ],
      completions: async () => [{ workItemId: 'h#F-9', title: 'internal done', userRequested: false, ts: '2026-06-04T03:02:00Z' }],
    });
    const result = await runCurationTick(deps, { canEmitDigest: true });
    expect(result.digestEmitted).toBe(true);
    expect(result.batchedCount).toBe(3);
    expect(surfaced).toHaveLength(1); // ONE digest, not three
    expect(surfaced[0]).toMatch(/Fleet update/);
    expect(recorded).toHaveLength(3);
  });

  it('defers the batch (no digest, nothing recorded) when canEmitDigest=false', async () => {
    const { deps, surfaced, recorded } = harness({
      progress: async () => [{ id: 'p1', title: 'F-1 → validating', ts: '2026-06-04T03:00:00Z' }],
    });
    const result = await runCurationTick(deps, { canEmitDigest: false });
    expect(result.digestEmitted).toBe(false);
    expect(result.deferredBatchCount).toBe(1);
    expect(surfaced).toHaveLength(0);
    expect(recorded).toHaveLength(0); // deferred items re-accumulate next tick
  });

  it('still surfaces urgent items even while deferring the batch (urgent wake path)', async () => {
    const { deps, surfaced } = harness({
      escalations: async () => [{ msgId: 'e1', severity: 'blocker', summary: 'wedged', ts: '2026-06-04T03:00:00Z' }],
      progress: async () => [{ id: 'p1', title: 'routine', ts: '2026-06-04T03:00:00Z' }],
    });
    const result = await runCurationTick(deps, { canEmitDigest: false });
    expect(result.surfacedCount).toBe(1);
    expect(result.deferredBatchCount).toBe(1);
    expect(surfaced).toHaveLength(1); // the escalation, not the routine
  });

  it('honors a digest-gate function over the pending batch size', async () => {
    const { deps, surfaced } = harness({
      progress: async () => Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, title: `t${i}`, ts: '2026-06-04T03:00:00Z' })),
    });
    // Gate that only allows a digest when ≥ 5 items pile up — 3 < 5 → deferred.
    const result = await runCurationTick(deps, { canEmitDigest: (n) => n >= 5 });
    expect(result.digestEmitted).toBe(false);
    expect(surfaced).toHaveLength(0);
  });

  it('stays completely silent on an empty fleet', async () => {
    const { deps, surfaced, recorded } = harness({});
    const result = await runCurationTick(deps);
    expect(surfaced).toHaveLength(0);
    expect(recorded).toHaveLength(0);
    expect(result).toMatchObject({ surfacedCount: 0, batchedCount: 0, digestEmitted: false, hasUrgent: false });
  });
});

describe('formatters', () => {
  const c = (over: Partial<ClassifiedSignal['signal']> & { kind: ClassifiedSignal['signal']['kind'] }): ClassifiedSignal => ({
    signal: { id: 'x', title: 't', ts: '1', ...over },
    verdict: { disposition: 'surface', urgent: false, reason: '' },
  });

  it('formatSignalLine includes marker, label, title, and drill-in', () => {
    const line = formatSignalLine(c({ kind: 'blocker', title: 'wedged', ref: 'wi:h#F-1', harness: 'restart' }));
    expect(line).toMatch(/Blocked/);
    expect(line).toMatch(/\[restart\]/);
    expect(line).toMatch(/wedged/);
    expect(line).toMatch(/drill in: `wi:h#F-1`/);
  });

  it('formatSignalLine flags user-requested completions', () => {
    expect(formatSignalLine(c({ kind: 'completion', userRequested: true, title: 'F-9' }))).toMatch(/you asked for this/);
    expect(formatSignalLine(c({ kind: 'completion', userRequested: false, title: 'F-9' }))).not.toMatch(/you asked for this/);
  });

  it('formatSurfaceMessage joins lines', () => {
    const msg = formatSurfaceMessage([c({ kind: 'escalation', title: 'a' }), c({ kind: 'decision', title: 'b' })]);
    expect(msg.split('\n')).toHaveLength(2);
  });

  it('formatBatchDigest is a single calm digest with counts', () => {
    const batch = [
      c({ kind: 'progress', title: 'p1' }),
      c({ kind: 'progress', title: 'p2' }),
      c({ kind: 'completion', title: 'c1' }),
    ];
    const digest = formatBatchDigest(batch);
    expect(digest).toMatch(/Fleet update/);
    expect(digest).toMatch(/2 items progressed/);
    expect(digest).toMatch(/1 completed/);
  });
});

describe('backoff / cadence helpers', () => {
  it('nextInterval resets to BASE when busy, grows toward MAX when quiet', () => {
    expect(nextInterval(600, true)).toBe(BASE_INTERVAL_SECONDS);
    const grown = nextInterval(BASE_INTERVAL_SECONDS, false);
    expect(grown).toBeGreaterThan(BASE_INTERVAL_SECONDS);
    // Grows but never exceeds the cap.
    let v = BASE_INTERVAL_SECONDS;
    for (let i = 0; i < 20; i++) v = nextInterval(v, false);
    expect(v).toBe(MAX_INTERVAL_SECONDS);
  });

  it('shouldRunTick honors the interval since last run', () => {
    const now = 1_000_000_000_000;
    expect(shouldRunTick(null, 120, now)).toBe(true); // never run
    expect(shouldRunTick(now - 60_000, 120, now)).toBe(false); // only 60s since, interval 120s
    expect(shouldRunTick(now - 130_000, 120, now)).toBe(true); // 130s since
  });

  it('canEmitDigestNow rate-limits by gap, forces on burst, never on empty', () => {
    const now = 1_000_000_000_000;
    expect(canEmitDigestNow(now, 0, now)).toBe(false); // empty batch
    expect(canEmitDigestNow(null, 1, now)).toBe(true); // never digested
    expect(canEmitDigestNow(now - 10_000, 1, now)).toBe(false); // within gap, small batch
    expect(canEmitDigestNow(now - 10_000, DIGEST_BURST_THRESHOLD, now)).toBe(true); // burst overrides gap
    expect(canEmitDigestNow(now - (DIGEST_MIN_GAP_SECONDS + 1) * 1000, 1, now)).toBe(true); // gap elapsed
  });
});
