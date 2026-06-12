/**
 * scan.test.ts — the neologism miner's tick glue (self-learning-frontier
 * P-011 / FB-05), with injected deps (no PG, no fs): the read→aggregate→
 * select→capture flow, the Scout-rail capture shape, the per-candidate
 * best-effort discipline, and the mine-only mode.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CaptureImprovementResult } from '../harness/improvements/capture-core';
import type { CoordTextRow } from './miner-core';
import { neologismCaptureInput, runNeologismTick, type NeologismTickDeps } from './scan';

const AS_OF = '2026-06-12T00:00:00.000Z';
const daysAgo = (d: number) => new Date(Date.parse(AS_OF) - d * 86_400_000).toISOString();

/** Four speakers bursting an unnamed term in the recent window — distinct
 *  prose per row (identical texts would collapse as template re-broadcasts). */
const VARY = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const burstRows: CoordTextRow[] = Array.from({ length: 5 }, (_, i) => ({
  speaker: `agent-${i % 4}`,
  text: `heads up ${VARY[i]}: another wake-storm in the fleet`,
  at: daysAgo(i + 1),
}));

const created = (id: string): CaptureImprovementResult =>
  ({ ok: true, created: true, issue: { id } as never, possibleDuplicates: [] }) as never;
const declinedDup = (id: string): CaptureImprovementResult =>
  ({
    ok: true,
    created: false,
    reason: 'likely-duplicate',
    possibleDuplicates: [{ id, title: 't', state: 'open', severity: 'minor', similarity: 0.9 }],
  }) as never;

function fakeDeps(over: Partial<NeologismTickDeps> = {}) {
  const capture = vi.fn(async () => created('EI-1'));
  const deps: NeologismTickDeps = {
    readRows: vi.fn(async () => burstRows),
    readInsights: vi.fn(async () => [{ slug: 'wake-storm-runbook', text: 'the wake-storm pattern' }]),
    readNamespaces: vi.fn(async () => ['memory:search', 'negative_space_demand']),
    capture,
    log: () => {},
    ...over,
  };
  return { deps, capture: (over.capture as ReturnType<typeof vi.fn>) ?? capture };
}

describe('runNeologismTick', () => {
  it('mines, selects over the bars, and files through the capture core', async () => {
    const { deps, capture } = fakeDeps();
    const result = await runNeologismTick('ws-1', deps, { asOf: AS_OF });
    expect(deps.readRows).toHaveBeenCalledWith('ws-1', 30);
    expect(result.scannedRows).toBe(5);
    expect(result.insightDocs).toBe(1);
    expect(result.filed).toEqual(['EI-1']);
    expect(result.declined).toBe(0);
    const input = capture.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      title: 'Abstraction proposal: name the recurring fleet term "wake storm"',
      kind: 'change',
      severity: 'minor',
      subTopic: 'neologism',
      sourceRole: 'system',
      source: 'su',
      watchdogKey: 'neologism:wake-storm',
      dedupScope: 'all',
      evidenceAt: daysAgo(1),
      createdBy: 'system:neologism-mine',
      origin: 'organic',
    });
    // The body is Scout's improvementBody over the abstraction proposal:
    // evidence + mechanism + the D-006 cheap experiment.
    const body = input.body as string;
    expect(body).toContain('**Mechanism:**');
    expect(body).toContain('Cheap experiment (D-006)');
    expect(body).toContain('wake-storm-runbook');
    expect(body).toContain('4 distinct agent(s)');
  });

  it('a namespace-covered term never becomes a candidate', async () => {
    const { deps, capture } = fakeDeps({
      readNamespaces: vi.fn(async () => ['system:wake-storm-monitor']),
    });
    const result = await runNeologismTick('ws-1', deps, { asOf: AS_OF });
    expect(capture).not.toHaveBeenCalled();
    // The covered term is gone; the fixtures' incidental one-off bigrams stay
    // under the fire bars, so nothing files.
    expect(result.entries.find((e) => e.term === 'wake storm')).toBeUndefined();
    expect(result.overBars).toBe(0);
    expect(result.filed).toEqual([]);
  });

  it('maxPerTick 0 is mine-only: the map is computed, nothing files', async () => {
    const { deps, capture } = fakeDeps();
    const result = await runNeologismTick('ws-1', deps, { asOf: AS_OF, maxPerTick: 0 });
    expect(capture).not.toHaveBeenCalled();
    expect(result.terms).toBeGreaterThan(0);
    expect(result.overBars).toBeGreaterThan(0);
    expect(result.entries.find((e) => e.term === 'wake storm')).toBeDefined();
  });

  it('a declined capture counts, and one capture failure never aborts the tick', async () => {
    // Two distinct burst terms → two candidates; first throws, second declines.
    const rows: CoordTextRow[] = [
      ...burstRows,
      ...Array.from({ length: 5 }, (_, i) => ({
        speaker: `agent-${i % 4}`,
        text: `the deploy-train derailed again ${VARY[i]}`,
        at: daysAgo(i + 1),
      })),
    ];
    const capture = vi
      .fn()
      .mockRejectedValueOnce(new Error('pg down'))
      .mockResolvedValueOnce(declinedDup('EI-9'));
    const { deps } = fakeDeps({ readRows: vi.fn(async () => rows), capture });
    const result = await runNeologismTick('ws-1', deps, { asOf: AS_OF });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(result.filed).toEqual([]);
    expect(result.declined).toBe(2);
  });
});

describe('neologismCaptureInput', () => {
  it('stamps the term-keyed watchdogKey and the last-seen evidence timestamp', () => {
    const input = neologismCaptureInput(
      {
        term: 'arming gate',
        recentMentions: 4,
        priorMentions: 0,
        distinctSpeakers: 3,
        growth: 9,
        insightSlugs: [],
        firstSeenAt: daysAgo(5),
        lastSeenAt: daysAgo(2),
        exampleText: 'past the arming gate',
      },
      30,
    );
    expect(input.watchdogKey).toBe('neologism:arming-gate');
    expect(input.evidenceAt).toBe(daysAgo(2));
    expect(input.title).not.toMatch(/\d/);
  });
});
