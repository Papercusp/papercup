import type { BugInflowScoreboardInput } from './bug-inflow';

/** Synthetic host-resolved inputs. These never attest live capture or authorship. */
export function scoreboardFixture(): BugInflowScoreboardInput {
  const start = Date.parse('2026-10-12T00:00:00Z');
  const dayMs = 86_400_000;
  const registryHash = '050a169d8e6ddabc2f2e00f54a1807216191bab254756568c12b1a484147c262';
  const closure = { 'packages/operator-core/lib/harness/improvements/bug-inflow.ts': 'f'.repeat(64) };
  const authors = ['implementation-a', 'proof-author'];
  const receipts = Array.from({ length: 7 }, (_, i) => {
    const day = start + i * dayMs;
    const actualFireAt = new Date(day + 2 * dayMs + 60_000).toISOString();
    const metrics = {
      filedPerDayBySource: { countsBySource: { agent: 2 } },
      closedPerDay: { ordinary: 3, cleanup: 1, fold: 2, reopenedOrdinary: 1, adjustedOrdinary: 2 },
      shareReviewed: { numerator: 2, denominator: 2, onTimeNumerator: 2, onTimeDenominator: 2 },
      shareBypassed: { numerator: 0, denominator: 2, routes: {}, reasons: {} },
      reviewerWait: {
        rows: [1, 2].map(n => ({
          itemId: `fixture-${i}-${n}`,
          filedAt: new Date(day + n * 3_600_000).toISOString(),
          decidedAt: new Date(day + (n + 1) * 3_600_000).toISOString(),
          waitMs: 3_600_000,
          flaggedAt: new Date(day + n * 3_600_000).toISOString(),
          dueAt: new Date(day + (n + 48) * 3_600_000).toISOString(),
        })),
        pending: 0, rightCensored: 0, missing: 0,
      },
      mergesPerDay: { committed: 2, duplicate: 2, alreadyFolded: 1, protected: 0, failed: 0 },
      claimableCount: { count: 1, population: 4, protected: 1, held: 1, blocked: 1, unknown: 0 },
    };
    const sourceHash = (i + 1).toString(16).repeat(64);
    return {
      id: `fixture-run-${i}`, epochId: 'fixture-epoch', routineId: 'fixture-daily-routine',
      windowStart: new Date(day).toISOString(), windowEnd: new Date(day + dayMs).toISOString(),
      expectedFireAt: new Date(day + 2 * dayMs).toISOString(), actualFireAt,
      measuredAt: new Date(Date.parse(actualFireAt) + 5_000).toISOString(),
      registryHash, originalClockHash: 'c'.repeat(64),
      runtime: { buildSha: 'a'.repeat(40), closure },
      source: {
        ref: `fixture-source-${i}`, sha256: sourceHash, complete: true,
        totalRows: 20, rowsRead: 20, omitted: 0, nextCursor: null, cohortSize: 2,
      },
      writerQueryHash: 'd'.repeat(64), writerAggregateRefs: ['fixture:writer-aggregate'], metrics,
      independent: {
        artifactRef: `fixture-independent-${i}`, authorId: 'assessor-external',
        lineage: { eligible: true, checkedAgainst: authors, receiptRef: `fixture-lineage-${i}` },
        sourceHash, registryHash, queryHash: 'e'.repeat(64), aggregateRefs: ['fixture:independent-aggregate'],
        closure, originalClockHash: 'c'.repeat(64), complete: true, omitted: 0,
        metrics: structuredClone(metrics),
      },
    };
  });
  return {
    registryHash, implementationAuthors: authors, activeEpochId: 'fixture-epoch',
    epochHistory: {
      complete: true, omitted: 0, nextCursor: null,
      epochs: [{
        id: 'fixture-epoch', candidateSha: 'a'.repeat(40), activatedAt: new Date(start).toISOString(),
        closure, originalClockHash: 'c'.repeat(64), disposition: 'active', artifactRef: 'fixture-epoch-artifact',
      }],
    },
    cadence: {
      routineId: 'fixture-daily-routine', firstWindowStart: new Date(start).toISOString(),
      intervalMs: dayMs, maxDelayMs: 300_000, maxRuntimeMs: 300_000,
    },
    receipts,
  };
}
