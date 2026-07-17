import { describe, it, expect } from 'vitest';
import {
  runCurationTick,
  computeClearedSignals,
  formatSignalLine,
  formatSurfaceMessage,
  formatBatchDigest,
  signalToReportItem,
  buildSurfaceReport,
  buildDigestReport,
  nextInterval,
  shouldRunTick,
  canEmitDigestNow,
  BASE_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  DIGEST_MIN_GAP_SECONDS,
  DIGEST_BURST_THRESHOLD,
  type CurationDeps,
} from './curation-loop';
import { gatherFleetSignals, type FleetReaders } from './fleet-signals';
import type { SurfacedEntry, OpenRecoverableEntry } from './curation-log';
import type { ClassifiedSignal } from './salience-policy';

const EMPTY_READERS: FleetReaders = {
  escalations: async () => [],
  blocked: async () => [],
  decisions: async () => [],
  completions: async () => [],
  progress: async () => [],
  health: async () => [],
  deadClaims: async () => [],
};

function harness(
  over: Partial<FleetReaders>,
  alreadySurfaced = new Set<string>(),
  openRecoverable: OpenRecoverableEntry[] = [],
) {
  const surfaced: string[] = [];
  const surfacedReports: Array<import('@papercusp/chat-protocol').ReportBlock | undefined> = [];
  const recorded: SurfacedEntry[] = [];
  const deps: CurationDeps = {
    readers: { ...EMPTY_READERS, ...over },
    loadSurfaced: async () => alreadySurfaced,
    recordSurfaced: async (entries) => {
      recorded.push(...entries);
    },
    surface: async (text, report) => {
      surfaced.push(text);
      surfacedReports.push(report);
    },
    loadOpenRecoverable: async () => openRecoverable,
  };
  return { deps, surfaced, surfacedReports, recorded };
}

/** Minimal ClassifiedSignal for the pure card-builder tests (the builders read
 *  only `.signal`; `verdict` is irrelevant here). */
function cs(signal: {
  id: string;
  kind: import('./salience-policy').FleetSignalKind;
  title: string;
  detail?: string;
  harness?: string;
  ref?: string;
  userRequested?: boolean;
}): ClassifiedSignal {
  return { signal, verdict: {} } as unknown as ClassifiedSignal;
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

describe('computeClearedSignals — pure diff (P-003)', () => {
  const NOW = () => Date.parse('2026-07-17T12:00:00Z');

  it('emits a cleared signal for an open-recoverable id absent from the current gather', () => {
    const out = computeClearedSignals(
      new Set<string>(),
      [{ id: 'blocked:wi:h#1', kind: 'blocker', title: 'W1 wedged' }],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'cleared:blocked:wi:h#1', kind: 'cleared', title: 'W1 wedged', ref: 'blocked:wi:h#1' });
    expect(out[0].ts).toBe(new Date(NOW()).toISOString());
  });

  it('does NOT clear an id still present in the current gather', () => {
    const out = computeClearedSignals(
      new Set(['blocked:wi:h#1']),
      [{ id: 'blocked:wi:h#1', kind: 'blocker', title: 'W1 wedged' }],
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  it('falls back to the id when title is null', () => {
    const out = computeClearedSignals(new Set(), [{ id: 'escalation:e1', kind: 'escalation', title: null }], NOW);
    expect(out[0].title).toBe('escalation:e1');
  });

  it('is a no-op with no open-recoverable entries', () => {
    expect(computeClearedSignals(new Set(['x']), [], NOW)).toHaveLength(0);
  });
});

describe('runCurationTick — recovery close-the-loop (P-003)', () => {
  it('surfaces a "✓ cleared" line + records it when an open blocker vanishes from the gather', async () => {
    const { deps, surfaced, recorded } = harness(
      {},
      new Set<string>(),
      [{ id: 'blocked:wi:h#1', kind: 'blocker', title: 'W1 wedged' }],
    );
    const result = await runCurationTick(deps);
    expect(result.surfacedCount).toBe(1);
    expect(surfaced[0]).toMatch(/Cleared/);
    expect(surfaced[0]).toMatch(/W1 wedged/);
    expect(recorded).toContainEqual({ id: 'cleared:blocked:wi:h#1', kind: 'cleared', title: 'W1 wedged' });
  });

  it('does NOT clear an open blocker that is still present in the gather', async () => {
    const { deps, surfaced } = harness(
      { blocked: async () => [{ ref: 'wi:h#1', title: 'W1 wedged' }] },
      new Set<string>(),
      [{ id: 'blocked:wi:h#1', kind: 'blocker', title: 'W1 wedged' }],
    );
    const result = await runCurationTick(deps);
    // The still-open blocker itself surfaces; no separate "cleared" line.
    expect(result.surfacedCount).toBe(1);
    expect(surfaced[0]).not.toMatch(/Cleared/);
  });

  it('the cleared signal is idempotency-suppressed once already recorded (fires once)', async () => {
    const { deps, surfaced } = harness(
      {},
      new Set(['cleared:blocked:wi:h#1']), // already recorded last tick
      [{ id: 'blocked:wi:h#1', kind: 'blocker', title: 'W1 wedged' }],
    );
    const result = await runCurationTick(deps);
    expect(result.surfacedCount).toBe(0);
    expect(surfaced).toHaveLength(0);
  });

  it('is a no-op when loadOpenRecoverable is omitted (pre-P-003 caller compatibility)', async () => {
    const surfacedMsgs: string[] = [];
    const deps: CurationDeps = {
      readers: EMPTY_READERS,
      loadSurfaced: async () => new Set(),
      recordSurfaced: async () => {},
      surface: async (t) => {
        surfacedMsgs.push(t);
      },
    };
    const result = await runCurationTick(deps);
    expect(result.surfacedCount).toBe(0);
    expect(surfacedMsgs).toHaveLength(0);
  });
});

describe('runCurationTick — end-to-end across P-001/P-002/P-003 together (P-004 verification lane)', () => {
  const T1 = '2026-07-17T12:00:00Z';

  /** One tick's readers: a bare-blocked work_item (P-001), a crit + a warn
   *  health panel (P-002), and one decision — chosen to exercise the
   *  low-priority 'decision' kind interleaved with the two urgent 'blocker'
   *  kinds so precedence ordering is genuinely tested, not incidental. */
  function busyTickReaders(): Partial<FleetReaders> {
    return {
      blocked: async () => [
        { ref: 'papercup#F-BLOCKED', title: 'F-BLOCKED', reason: 'stuck', harness: 'papercup', workItemId: 'F-BLOCKED', ts: T1 },
      ],
      decisions: async () => [{ id: 'review:1', title: 'needs design review', ts: T1 }],
      health: async () => [
        { panelId: 'queen', status: 'crit', label: 'Mug', summary: 'stalled 47m', ts: T1 },
        { panelId: 'disk', status: 'warn', label: 'Infra', summary: 'disk at 88%', ts: T1 },
      ],
    };
  }

  it('dedup ids are stable across two independent gathers of the same underlying state', async () => {
    const readers = { ...EMPTY_READERS, ...busyTickReaders() };
    const first = await gatherFleetSignals(readers);
    const second = await gatherFleetSignals(readers);
    expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
    // Sanity: one id per source, and the P-001/P-002 ids carry the expected shape.
    expect(first.map((s) => s.id).sort()).toEqual(
      ['blocked:papercup#F-BLOCKED', 'decision:review:1', 'health:disk', 'health:queen'].sort(),
    );
  });

  it('crit-panel precedence: a crit health panel (urgent) surfaces ahead of a non-urgent decision even though it is gathered later, alongside the P-001 blocked work_item', async () => {
    const { deps, surfaced, recorded } = harness(busyTickReaders());
    // Isolate the always-surface path from the digest-rate-limiting knob
    // (that's the workflow's concern, covered by the backoff/cadence tests
    // below) — the warn health panel deliberately stays deferred here.
    const result = await runCurationTick(deps, { canEmitDigest: false });

    // All three always-surface kinds fire this tick; the warn panel batches.
    expect(result.surfacedCount).toBe(3);
    expect(result.batchedCount).toBe(0);
    expect(result.deferredBatchCount).toBe(1); // the warn health panel — deferred, re-accumulates

    const message = surfaced[0];
    const blockedIdx = message.indexOf('F-BLOCKED');
    const critIdx = message.indexOf('Mug: stalled 47m');
    const decisionIdx = message.indexOf('needs design review');
    expect(blockedIdx).toBeGreaterThanOrEqual(0);
    expect(critIdx).toBeGreaterThanOrEqual(0);
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    // Both urgent (blocker-kind) lines precede the non-urgent decision line.
    expect(blockedIdx).toBeLessThan(decisionIdx);
    expect(critIdx).toBeLessThan(decisionIdx);

    expect(recorded.map((r) => r.id)).toEqual(
      expect.arrayContaining(['blocked:papercup#F-BLOCKED', 'health:queen', 'decision:review:1']),
    );
    // The warn panel was deferred (batch, not yet digested) — never recorded.
    expect(recorded.map((r) => r.id)).not.toContain('health:disk');
  });

  it('cleared-after-surfaced: once the P-001 blocked item resolves AND the P-002 crit panel clears, the next tick emits a "✓ cleared" line for each — never for the still-batched warn panel', async () => {
    // Tick 1: everything as above, fully surfaced + recorded (the digest gate
    // is irrelevant here — only the always-surface kinds matter for recovery).
    const tick1 = harness(busyTickReaders());
    await runCurationTick(tick1.deps);
    const recoverableFromTick1 = tick1.recorded
      .filter((r) => r.kind === 'blocker' || r.kind === 'escalation')
      .map((r) => ({ id: r.id, kind: r.kind, title: r.title ?? null }));
    expect(recoverableFromTick1.map((r) => r.id).sort()).toEqual(
      ['blocked:papercup#F-BLOCKED', 'health:queen'].sort(),
    );

    // Tick 2: the source rows are gone (work_item unblocked, health back to
    // ok) — reuse tick 1's OWN recorded ids as the open-recoverable input,
    // proving the ids the sources produced are the exact ones the recovery
    // diff consumes (real id-stability, not a hand-typed duplicate).
    const tick2 = harness({}, new Set<string>(), recoverableFromTick1);
    const result2 = await runCurationTick(tick2.deps);

    expect(result2.surfacedCount).toBe(2);
    expect(tick2.surfaced).toHaveLength(1);
    expect(tick2.surfaced[0]).toMatch(/Cleared[\s\S]*F-BLOCKED/);
    expect(tick2.surfaced[0]).toMatch(/Cleared[\s\S]*Mug: stalled 47m/);
    expect(tick2.recorded.map((r) => r.id).sort()).toEqual(
      ['cleared:blocked:papercup#F-BLOCKED', 'cleared:health:queen'].sort(),
    );
    // The warn-tier health panel (batch-only, never recoverable) never gets a
    // cleared line even though it also vanished — it was never in RECOVERABLE_KINDS.
    expect(tick2.surfaced[0]).not.toMatch(/disk/);
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

  it('formatSignalLine renders a crit health panel (kind blocker) with its own title', () => {
    const line = formatSignalLine(c({ kind: 'blocker', title: 'Mug: stalled 47m', ref: 'health:queen' }));
    expect(line).toMatch(/Blocked/);
    expect(line).toMatch(/Mug: stalled 47m/);
    expect(line).toMatch(/drill in: `health:queen`/);
  });

  it('formatBatchDigest counts warn-tier health signals distinctly from progress (P-002 D-007)', () => {
    const batch = [
      c({ kind: 'health', title: 'Infra: disk at 88%' }),
      c({ kind: 'progress', title: 'p1' }),
    ];
    const digest = formatBatchDigest(batch);
    expect(digest).toMatch(/1 health warning/);
    expect(digest).toMatch(/1 item progressed/);
    expect(digest).not.toMatch(/2 items progressed/);
  });

  describe('formatSignalLine / formatSurfaceMessage — P-006 aging annotation', () => {
    const OPENED = '2026-07-10T00:00:00Z';
    const openedMs = Date.parse(OPENED);
    const oneDayMs = 24 * 60 * 60 * 1000;

    it('appends "still open — day N" for an aged blocker, injecting `now`', () => {
      const line = formatSignalLine(c({ kind: 'blocker', title: 'wedged', ts: OPENED }), () => openedMs + 2 * oneDayMs);
      expect(line).toMatch(/still open — day 3/);
    });

    it('omits the annotation for a fresh signal (under the 1-day threshold)', () => {
      const line = formatSignalLine(c({ kind: 'blocker', title: 'wedged', ts: OPENED }), () => openedMs + 1000);
      expect(line).not.toMatch(/still open/);
    });

    it('never annotates a non-recoverable kind (e.g. completion), even when old', () => {
      const line = formatSignalLine(c({ kind: 'completion', title: 'F-9', ts: OPENED }), () => openedMs + 10 * oneDayMs);
      expect(line).not.toMatch(/still open/);
    });

    it('formatSurfaceMessage threads `now` through to every line', () => {
      const msg = formatSurfaceMessage(
        [c({ kind: 'blocker', title: 'wedged', ts: OPENED }), c({ kind: 'decision', title: 'd', ts: OPENED })],
        () => openedMs + 5 * oneDayMs,
      );
      const lines = msg.split('\n');
      expect(lines[0]).toMatch(/still open — day 6/);
      expect(lines[1]).not.toMatch(/still open/); // decision is not an aging-eligible kind
    });
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

describe('status cards — deterministic-status-cards P-002/P-003', () => {
  const FIXED = Date.UTC(2026, 6, 17, 12, 0, 0);
  const now = () => FIXED;

  it('signalToReportItem maps kind→status token, keeps the label in text, carries the ref', () => {
    const item = signalToReportItem(
      cs({ id: 'escalation:e1', kind: 'blocker', title: 'Cups / fleet: no bees running', harness: 'infra-liveness', ref: 'escalation:e1' }),
      now,
    );
    expect(item.status).toBe('blocked'); // ■ tone
    expect(item.ref).toBe('escalation:e1'); // the drill-in
    expect(item.text).toContain('**Blocked**'); // label preserved (information-preservation)
    expect(item.text).toContain('[infra-liveness]'); // source chip
    expect(item.text).toContain('Cups / fleet: no bees running');
    expect(item.text).not.toContain('drill in'); // the ref is structured, not in the text
  });

  it('a cleared signal → resolved (● good), a completion → done, a decision → needs-human', () => {
    expect(signalToReportItem(cs({ id: 'cleared:e1', kind: 'cleared', title: 'x', ref: 'e1' }), now).status).toBe('resolved');
    expect(signalToReportItem(cs({ id: 'c1', kind: 'completion', title: 'x' }), now).status).toBe('done');
    expect(signalToReportItem(cs({ id: 'd1', kind: 'decision', title: 'x' }), now).status).toBe('needs-human');
  });

  it('a signal with no ref yields an item with no ref key (no dead drill-in)', () => {
    const item = signalToReportItem(cs({ id: 'p1', kind: 'progress', title: 'moved' }), now);
    expect('ref' in item).toBe(false);
  });

  it('buildSurfaceReport → one Fleet status plan, one item per signal, refs preserved', () => {
    const report = buildSurfaceReport(
      [
        cs({ id: 'escalation:e1', kind: 'blocker', title: 'blocked thing', ref: 'escalation:e1' }),
        cs({ id: 'cleared:e2', kind: 'cleared', title: 'cleared thing', ref: 'e2' }),
      ],
      now,
    );
    expect(report.plans).toHaveLength(1);
    expect(report.plans[0]?.title).toBe('Fleet status');
    expect(report.plans[0]?.items).toHaveLength(2);
    expect(report.plans[0]?.items?.[0]?.ref).toBe('escalation:e1');
    expect(report.plans[0]?.items?.[1]?.status).toBe('resolved');
  });

  it('buildDigestReport → the count header as the card title, rows capped', () => {
    const batch = Array.from({ length: 25 }, (_, i) => cs({ id: `p${i}`, kind: 'progress', title: `item ${i}` }));
    const report = buildDigestReport(batch, now);
    expect(report.title).toMatch(/Fleet update/);
    expect(report.plans[0]?.items?.length).toBeLessThanOrEqual(20); // DIGEST_CARD_MAX_ROWS
  });

  it('REGRESSION: formatSignalLine text output is byte-identical after the card refactor', () => {
    // The card must not change the text-only rendition (voice/search/fallback).
    const line = formatSignalLine(
      cs({ id: 'escalation:e1', kind: 'blocker', title: 'build wedged', detail: 'lock held', harness: 'papercup', ref: 'escalation:e1' }),
      now,
    );
    expect(line).toBe('🚧 **Blocked** [papercup] — build wedged · lock held · drill in: `escalation:e1`');
  });

  it('runCurationTick passes a status-card report to surface alongside the text', async () => {
    const { deps, surfaced, surfacedReports } = harness({
      escalations: async () => [
        { msgId: 'e1', severity: 'blocker', summary: 'build wedged', from: 'agent', planSlug: null, ts: new Date(FIXED).toISOString() },
      ],
    });
    const result = await runCurationTick(deps);
    expect(result.surfacedCount).toBe(1);
    expect(surfaced[0]).toMatch(/drill in/); // text fallback unchanged
    const report = surfacedReports[0];
    expect(report).toBeDefined();
    expect(report?.plans[0]?.items?.[0]?.ref).toBe('escalation:e1'); // the card carries the actionable ref
    expect(report?.plans[0]?.items?.[0]?.status).toBe('blocked');
  });
});
