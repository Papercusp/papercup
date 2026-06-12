/**
 * scan.test.ts — the graduation tick (self-learning-frontier P-046 / FB-19).
 * Fake deps, no PG. Pins: evidence mapping (evidence.ts), report filing
 * through the capture seam (kind=change, tiered watchdogKey, dedupScope
 * 'all', protected policy.ts path), the report cap, mineOnly, dormant-
 * tolerant regression legs, and payload tuning.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EngineerIssue } from '../issues-engineer';
import type { CaptureImprovementResult } from '../harness/improvements/capture-core';
import { evidenceItemsFromIssues, type GraduationEvidenceDeps } from './evidence';
import {
  DEFAULT_GRADUATION_TICK_OPTIONS,
  graduationOptionsFromPayload,
  runGraduationTick,
  type GraduationTickDeps,
} from './scan';

const DAY = 86_400_000;
const T0 = 1_750_000_000_000;
const NOW = T0 + 120 * DAY;

let seq = 0;
function issue(over: Partial<EngineerIssue> & { payload?: unknown } = {}): EngineerIssue {
  seq += 1;
  const resolvedAt = new Date(T0 + seq * DAY).toISOString();
  return {
    id: over.id ?? `EI-${200 + seq}`,
    kind: 'bug',
    scope: 'operator',
    title: `finding ${seq}`,
    body: '',
    severity: 'minor',
    source: 'watchdog',
    state: 'resolved',
    assignee: null,
    assignedBy: null,
    assignedAt: null,
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: null,
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    createdAt: resolvedAt,
    updatedAt: resolvedAt,
    ...over,
    payload:
      'payload' in over
        ? over.payload
        : {
            findingClass: 'negative-space:resolution-gap',
            watchdogKey: `negative-space:gap-${seq}`,
            ideaLifecycle: { state: 'verified', stateUpdatedAt: new Date(T0 + (seq + 14) * DAY).toISOString(), decayDays: 14 },
          },
  } as EngineerIssue;
}

function fakeDeps(issues: EngineerIssue[], autoIds: string[]): GraduationTickDeps & {
  fileReport: ReturnType<typeof vi.fn>;
} {
  const fileReport = vi.fn(
    async (): Promise<CaptureImprovementResult> =>
      ({ ok: true, created: true, issue: { id: 'EI-900' }, possibleDuplicates: [] }) as never,
  );
  const evidence: GraduationEvidenceDeps = {
    listResolvedImprovements: async () => issues,
    listAutoResolvedItemIds: async () => new Set(autoIds),
    listGymRegressions: async () => [],
    listEkgRegressions: async () => [],
  };
  return { evidence, fileReport, nowMs: () => NOW };
}

describe('evidenceItemsFromIssues (the read-seam mapping)', () => {
  it('maps lifecycle rows and back-derives resolution time for verified items', () => {
    seq = 0;
    const rows = [issue()];
    const items = evidenceItemsFromIssues(rows, new Set([rows[0].id]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      findingClass: 'negative-space:resolution-gap',
      lifecycle: 'verified',
      autoDispatched: true,
      hasEvidence: true,
    });
    // stateUpdatedAt − decayDays ⇒ the applied flip.
    expect(items[0].resolvedAtMs).toBe(T0 + 1 * DAY);
  });

  it('skips rows without a lifecycle (pre-P-031 legacy / closed without the back-edge)', () => {
    seq = 0;
    const rows = [issue({ payload: { watchdogKey: 'flake:x' } }), issue({ payload: null })];
    expect(evidenceItemsFromIssues(rows, new Set())).toHaveLength(0);
  });

  it('falls back to the watchdog family when findingClass is absent (pre-P-044 rows)', () => {
    seq = 0;
    const rows = [
      issue({
        payload: {
          watchdogKey: 'flake:lib/foo.test.ts',
          ideaLifecycle: { state: 'applied', stateUpdatedAt: new Date(T0 + DAY).toISOString() },
        },
      }),
    ];
    const items = evidenceItemsFromIssues(rows, new Set());
    expect(items[0].findingClass).toBe('flake:unclassified');
    expect(items[0].lifecycle).toBe('applied');
    expect(items[0].resolvedAtMs).toBe(T0 + DAY);
  });
});

describe('runGraduationTick', () => {
  it('files ONE tiered owner report per eligible class through the capture seam', async () => {
    seq = 0;
    const issues = Array.from({ length: 10 }, () => issue());
    const deps = fakeDeps(issues, issues.map((i) => i.id));
    const result = await runGraduationTick(deps, DEFAULT_GRADUATION_TICK_OPTIONS);

    expect(result.eligible).toEqual(['negative-space:resolution-gap']);
    expect(result.filed).toEqual(['EI-900']);
    expect(deps.fileReport).toHaveBeenCalledTimes(1);
    const input = deps.fileReport.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      kind: 'change',
      watchdogKey: 'graduation:negative-space:resolution-gap:n10',
      dedupScope: 'all',
      sourceRole: 'system',
      origin: 'organic',
      findingClass: 'graduation:eligibility-report',
      // The would-be implementation path is PROTECTED — the ask can never
      // ride the auto lane it proposes to widen.
      paths: ['packages/operator-core/lib/harness/improvements/policy.ts'],
    });
    expect(String(input.title)).toContain('10 consecutive clean auto-passes');
    expect(String(input.body)).toContain('NEVER automatic');
  });

  it('not eligible ⇒ nothing files', async () => {
    seq = 0;
    const issues = Array.from({ length: 4 }, () => issue());
    const deps = fakeDeps(issues, issues.map((i) => i.id));
    const result = await runGraduationTick(deps, DEFAULT_GRADUATION_TICK_OPTIONS);
    expect(result.eligible).toEqual([]);
    expect(deps.fileReport).not.toHaveBeenCalled();
  });

  it('non-auto resolutions never make a class eligible (the dispatch ledger is ground truth)', async () => {
    seq = 0;
    const issues = Array.from({ length: 12 }, () => issue());
    const deps = fakeDeps(issues, []); // nothing auto-dispatched
    const result = await runGraduationTick(deps, DEFAULT_GRADUATION_TICK_OPTIONS);
    expect(result.eligible).toEqual([]);
    expect(deps.fileReport).not.toHaveBeenCalled();
  });

  it('mineOnly computes standings but files nothing (the supervised dry mode)', async () => {
    seq = 0;
    const issues = Array.from({ length: 10 }, () => issue());
    const deps = fakeDeps(issues, issues.map((i) => i.id));
    const result = await runGraduationTick(deps, { ...DEFAULT_GRADUATION_TICK_OPTIONS, mineOnly: true });
    expect(result.eligible).toEqual(['negative-space:resolution-gap']);
    expect(result.filed).toEqual([]);
    expect(deps.fileReport).not.toHaveBeenCalled();
  });

  it('caps reports per tick (strongest classes first) and counts dedup declines', async () => {
    seq = 0;
    const a = Array.from({ length: 12 }, () =>
      issue({
        payload: {
          findingClass: 'negative-space:resolution-gap',
          ideaLifecycle: { state: 'verified', stateUpdatedAt: new Date(T0 + (seq + 15) * DAY).toISOString(), decayDays: 14 },
        },
      }),
    );
    const b = Array.from({ length: 10 }, () =>
      issue({
        payload: {
          findingClass: 'flake:unclassified',
          ideaLifecycle: { state: 'verified', stateUpdatedAt: new Date(T0 + (seq + 15) * DAY).toISOString(), decayDays: 14 },
        },
      }),
    );
    const issues = [...a, ...b];
    const deps = fakeDeps(issues, issues.map((i) => i.id));
    deps.fileReport.mockResolvedValueOnce({ ok: true, created: true, issue: { id: 'EI-901' }, possibleDuplicates: [] } as never);
    deps.fileReport.mockResolvedValueOnce({ ok: true, created: false, reason: 'likely-duplicate', possibleDuplicates: [] } as never);

    const result = await runGraduationTick(deps, { ...DEFAULT_GRADUATION_TICK_OPTIONS, maxReportsPerTick: 2 });
    expect(result.eligible).toEqual(['negative-space:resolution-gap', 'flake:unclassified']);
    expect(deps.fileReport).toHaveBeenCalledTimes(2);
    expect(result.filed).toEqual(['EI-901']);
    expect(result.declined).toBe(1);
  });

  it('a regression-leg failure reports the leg inactive instead of failing the scan (dormant-tolerant)', async () => {
    seq = 0;
    const issues = Array.from({ length: 10 }, () => issue());
    const deps = fakeDeps(issues, issues.map((i) => i.id));
    deps.evidence.listEkgRegressions = async () => {
      throw new Error('relation fleet_ekg_shifts does not exist');
    };
    const result = await runGraduationTick(deps, DEFAULT_GRADUATION_TICK_OPTIONS);
    expect(result.legs).toEqual({ gym: true, ekg: false });
    expect(result.eligible).toEqual(['negative-space:resolution-gap']);
    const body = String((deps.fileReport.mock.calls[0][0] as Record<string, unknown>).body);
    expect(body).toContain('EKG inactive');
  });
});

describe('graduationOptionsFromPayload (owner tunables)', () => {
  it('defaults when payload is empty', () => {
    expect(graduationOptionsFromPayload(null)).toEqual(DEFAULT_GRADUATION_TICK_OPTIONS);
  });
  it('overrides knobs from payload_template', () => {
    const opts = graduationOptionsFromPayload({
      threshold: 20,
      maxReportsPerTick: 1,
      mineOnly: true,
      neverGraduateClassPatterns: ['auth'],
    });
    expect(opts.threshold).toBe(20);
    expect(opts.maxReportsPerTick).toBe(1);
    expect(opts.mineOnly).toBe(true);
    expect(opts.neverGraduateClassPatterns).toEqual(['auth']);
    expect(opts.recurrenceWindowDays).toBe(DEFAULT_GRADUATION_TICK_OPTIONS.recurrenceWindowDays);
  });
});
