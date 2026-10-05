/**
 * P-001 (gate-verdict-liveness-and-repair-reliability-2026-08-31) — the per-fire ledger.
 * Pins: (1) the single-homed outcome classification, (2) the anchor write's shape
 * (separate kind — the property that keeps the D-006 verdict-less clock honest),
 * (3) the reconstruction acceptance: the audit's "27 fires → 3 verdicts" table is
 * derivable from SQL rows alone, unaccounted (killed/vanished) fires included.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  GATE_FIRE_KIND,
  GATE_FIRE_STATUS,
  classifyGateOutcomeStatus,
  recordGateFire,
  reconstructGateFireDays,
  evaluateGateReuseAuditWindow,
  type GateOutcomeClass,
} from './gate-fire-ledger';
import { buildTestPassReuseHealth } from './test-pass-reuse-report';
import type { PipelineEventWindowRead } from '../harness/git-sync/pipeline-events';
import { auditDraw, formatTestReuseLine, formatTestReuseTotalLine } from '../../../../scripts/lib/test-pass-reuse.mjs';

describe('reuse audit population from immutable gate events', () => {
  const sha = 'c58655490ce1a3be734de61df08aa7f8159122d4';
  const ws = 'core::test:unit:pure';
  const sampledFile = Array.from({ length: 500 }, (_, i) => `lib/audit-${i}.test.ts`)
    .find((file) => auditDraw(file, sha) < 0.05)!;
  const fixture = (verdict = 'pass'): PipelineEventWindowRead => {
    const counts = { candidates: 20, reused: 19, audited: 1, expiredClean: 0 };
    const output = [formatTestReuseLine(ws, counts, ' auditRate=0.05 lane=pure'),
      formatTestReuseTotalLine({ tasks: 1, summaries: [counts], savedMs: 100, unmeasured: 0 }),
      'TEST_PASS_REUSE_AUDIT_RESULT ' + JSON.stringify({ version: 1, ws, file: sampledFile, verdict,
        judgedSha: sha, runnerIdentity: 'proof-v2 node25 linux x64', runContext: 'green-checkpoint',
        runGroupId: 'run-1', dirty: false })].join('\n');
    const health = buildTestPassReuseHealth(output, sha, 120)!;
    return { status: 'complete', windowStartMs: 100, windowEndMs: 200, total: 2, reason: null, rows: [
      { id: 'anchor', kind: 'green_checkpoint_fire', status: 'fired', createdAtMs: 110, detail: { gateFireId: 'fire-1' } },
      { id: 'outcome', kind: 'green_checkpoint', status: 'advanced', createdAtMs: 130, detail: {
        gateFireId: 'fire-1', runId: 'run-1', candidate: sha.slice(0, 12), testPassReuse: {
          audit: { ...health.audit, judgedSha: sha, recordedAtMs: 120 },
          auditRuns: health.auditRuns, auditedFiles: health.auditedFiles,
        } } },
    ] };
  };
  const mutate = (fn: (read: PipelineEventWindowRead) => void) => { const r = fixture(); fn(r); return r; };

  it('derives the complete named invocation population and passes only its observed audit', () => {
    expect(evaluateGateReuseAuditWindow(fixture())).toMatchObject({ verdict: 'pass', audited: 1,
      alarms: 0, fireIds: ['fire-1'], runIds: ['run-1'], evidenceRefs: ['pipeline-event:anchor', 'pipeline-event:outcome'] });
  });

  it('retains an inline-retry miss without any final FAIL console row', () => {
    expect(evaluateGateReuseAuditWindow(fixture('fail'))).toMatchObject({ verdict: 'fail', alarms: 1 });
  });

  it.each([
    ['capped', (r: PipelineEventWindowRead) => { r.status = 'capped'; }],
    ['empty', (r: PipelineEventWindowRead) => { r.rows = []; r.total = 0; }],
    ['missing outcome', (r: PipelineEventWindowRead) => { r.rows.pop(); r.total = r.rows.length; }],
    ['missing anchor', (r: PipelineEventWindowRead) => { r.rows.shift(); r.total = r.rows.length; }],
    ['unidentified fire', (r: PipelineEventWindowRead) => { delete r.rows[0]!.detail.gateFireId; }],
    ['cross-window start', (r: PipelineEventWindowRead) => { r.rows[0]!.createdAtMs = 90; }],
    ['cross-window outcome', (r: PipelineEventWindowRead) => { r.rows[1]!.createdAtMs = 210; }],
    ['no verdict', (r: PipelineEventWindowRead) => { r.rows[1]!.status = 'error'; }],
    ['historical archive', (r: PipelineEventWindowRead) => {
      delete (r.rows[1]!.detail.testPassReuse as Record<string, unknown>).auditRuns;
    }],
    ['source mismatch', (r: PipelineEventWindowRead) => { r.rows[1]!.detail.candidate = 'b'.repeat(12); }],
    ['partial draw population', (r: PipelineEventWindowRead) => {
      (r.rows[1]!.detail.testPassReuse as Record<string, unknown>).auditedFiles = [];
    }],
  ])('keeps %s unknown', (_label, fn) => {
    expect(evaluateGateReuseAuditWindow(mutate(fn)).verdict).toBe('unknown');
  });

  it('rejects a retry or foreign run-group result for the initial gate suite', () => {
    const r = fixture();
    const payload = r.rows[1]!.detail.testPassReuse as { auditedFiles: Array<{ runGroupId: string }> };
    payload.auditedFiles[0]!.runGroupId = 'run-1:retry';
    expect(evaluateGateReuseAuditWindow(r).verdict).toBe('unknown');
  });

  it('collapses matching producer/fallback archives but refuses conflicting evidence', () => {
    const r = fixture();
    r.rows.push({ ...r.rows[1]!, id: 'fallback', createdAtMs: 140 }); r.total = r.rows.length;
    expect(evaluateGateReuseAuditWindow(r).verdict).toBe('pass');
    r.rows[2] = { ...r.rows[2]!, detail: { ...r.rows[2]!.detail, runId: 'other' } };
    expect(evaluateGateReuseAuditWindow(r).verdict).toBe('unknown');
  });

  it('excludes an explicitly measured pre-suite skip while retaining it in coverage', () => {
    const r = fixture();
    r.rows.push({ ...r.rows[0]!, id: 'skip-anchor', detail: { gateFireId: 'fire-2' } },
      { id: 'skip', kind: 'green_checkpoint', status: 'skipped-locked', createdAtMs: 140, detail: { gateFireId: 'fire-2' } });
    r.total = r.rows.length;
    expect(evaluateGateReuseAuditWindow(r)).toMatchObject({ verdict: 'pass', excludedFireIds: ['fire-2'] });
  });
});

describe('classifyGateOutcomeStatus — single-homed outcome classes', () => {
  it('pins every status the ledger has actually recorded (measured 2026-08-30/31) plus the CLI vocabulary', () => {
    const expected: Record<string, GateOutcomeClass> = {
      // greens
      advanced: 'verdict-green',
      'advanced-prefix': 'verdict-green',
      'up-to-date': 'verdict-green',
      // the one red
      'not-green': 'verdict-red',
      // infra aborts / no-verdicts
      error: 'no-verdict',
      cancelled: 'no-verdict',
      'deadline-exceeded': 'no-verdict',
      'migrations-pending': 'no-verdict',
      'disk-headroom': 'no-verdict',
      'infra-inconclusive': 'no-verdict',
      // widened 2026-09-01 against the FULL live population (24 distinct statuses measured
      // via GROUP BY over kind='green_checkpoint'): standing pre-suite aborts, the P-006/P-007
      // exit-74 prerequisite outages, and WI-42207's withheld verdict
      'repair-staging-mismatch': 'no-verdict',
      'dependency-prewarm-missing': 'no-verdict',
      'dependency-generation-unusable': 'no-verdict',
      'candidate-fossil': 'no-verdict',
      // suite judged green, promotion failed — its own column, never a verdict-green
      'not-fast-forward': 'promotion-failed',
      'create-failed': 'promotion-failed',
      // the perf gates hold promotion AFTER a judged suite (stampPromotion(false, …))
      'perf-held': 'promotion-failed',
      'desktop-perf-held': 'promotion-failed',
      // mid-run bridge
      'decision-pending': 'pending',
      // pre-suite yields
      'repair-in-progress': 'skip',
      'unchanged-since-verdict': 'skip',
      // a release-fixer DISPATCH diagnostic riding the kind — routing, not a verdict
      'release-fixer-skipped-stale': 'skip',
      'skipped-locked': 'skip',
      'skipped-disabled': 'skip',
      'skipped-no-tooling': 'skip',
      'skipped-held': 'skip',
      'skipped-admission-unknown': 'skip',
      'skipped-memory-budget': 'skip',
      'skipped-joined-attempt': 'skip',
      'skipped-runner-liveness-unknown': 'skip',
      'skipped-qualification-unreadable': 'skip',
      'skipped-qualification-conflict': 'skip',
    };
    for (const [status, cls] of Object.entries(expected)) {
      expect({ status, cls: classifyGateOutcomeStatus(status) }).toEqual({ status, cls });
    }
  });

  it('an unknown skipped-* status still classifies as a skip (prefix rule)', () => {
    expect(classifyGateOutcomeStatus('skipped-some-future-guard')).toBe('skip');
  });

  it('a genuinely unknown status is UNKNOWN — visible, never silently absorbed', () => {
    expect(classifyGateOutcomeStatus('some-future-status')).toBe('unknown');
    expect(classifyGateOutcomeStatus('')).toBe('unknown');
  });
});

function makeCaptureSql(selectRows: unknown[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$');
    calls.push({ text, values });
    if (/^\s*SELECT/i.test(text)) return Promise.resolve(selectRows);
    return Promise.resolve(Object.assign([], { count: 1 }));
  }) as unknown as import('postgres').Sql;
  return { sql, calls };
}

describe('recordGateFire — the anchor write', () => {
  it('writes ONE row under the SEPARATE anchor kind, never under green_checkpoint', async () => {
    const { sql, calls } = makeCaptureSql();
    await recordGateFire(
      { workspaceId: 'papercusp-workspace', installSlug: 'papercusp' },
      { route: 'scheduled', root: '/repo', gateFireId: 'fire-123', note: 'tick' },
      sql,
    );
    const inserts = calls.filter((c) => c.text.includes('INSERT INTO harness_shared.pipeline_events'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toContain(GATE_FIRE_KIND);
    expect(inserts[0].values).toContain(GATE_FIRE_STATUS);
    expect(inserts[0].values).not.toContain('green_checkpoint'); // the load-bearing separation
    const detailJson = inserts[0].values.find((v) => typeof v === 'string' && v.includes('"route"')) as string;
    expect(JSON.parse(detailJson)).toMatchObject({
      route: 'scheduled',
      root: '/repo',
      gateFireId: 'fire-123',
      note: 'tick',
    });
  });

  it('is best-effort: a failing insert warns-and-noops, never throws into the fire it records', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = (() => Promise.reject(new Error('CHECK constraint violated'))) as unknown as import('postgres').Sql;
      await expect(
        recordGateFire({ workspaceId: 'w', installSlug: 'papercusp' }, { route: 'detached', unit: 'u.service' }, sql),
      ).resolves.toBeUndefined();
      // The pre-migration-1054 shape: the CHECK refuses the new kind and the anchor
      // degrades to exactly one visible warn — pinned so it stays visible, not silent.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('green_checkpoint_fire/fired'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('reconstructGateFireDays — the P-001 acceptance table', () => {
  const target = { workspaceId: 'papercusp-workspace', installSlug: 'papercusp' };
  const row = (day: string, kind: string, status: string, n: number) => ({ day, kind, status, n: String(n) });

  it('reconstructs the Aug-31-style "27 fires → 3 verdicts" day from rows alone, unaccounted included', async () => {
    const { sql } = makeCaptureSql([
      row('2026-08-31', GATE_FIRE_KIND, 'fired', 27),
      row('2026-08-31', 'green_checkpoint', 'not-green', 2),
      row('2026-08-31', 'green_checkpoint', 'advanced', 1),
      row('2026-08-31', 'green_checkpoint', 'skipped-locked', 9),
      row('2026-08-31', 'green_checkpoint', 'repair-in-progress', 6),
      row('2026-08-31', 'green_checkpoint', 'migrations-pending', 3),
      row('2026-08-31', 'green_checkpoint', 'error', 2),
      row('2026-08-31', 'green_checkpoint', 'decision-pending', 2),
    ]);
    const days = await reconstructGateFireDays(sql, target, { sinceDays: 30 });
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      day: '2026-08-31',
      fires: 27,
      outcomes: 25,
      verdictsGreen: 1,
      verdictsRed: 2,
      noVerdicts: 5,
      skips: 15,
      pending: 2,
      promotionFailed: 0,
      unknown: 0,
      unaccounted: 2, // 27 fires, 25 outcome rows — the killed/vanished class, from SQL alone
    });
  });

  it('a pre-anchor day (fires=0) reports unaccounted 0 rather than inventing negative history', async () => {
    const { sql } = makeCaptureSql([
      row('2026-08-30', 'green_checkpoint', 'not-green', 4),
      row('2026-08-30', 'green_checkpoint', 'skipped-locked', 7),
    ]);
    const days = await reconstructGateFireDays(sql, target, { sinceDays: 30 });
    expect(days[0]).toMatchObject({ day: '2026-08-30', fires: 0, outcomes: 11, unaccounted: 0 });
  });

  it('names unknown statuses instead of absorbing them', async () => {
    const { sql } = makeCaptureSql([
      row('2026-09-01', GATE_FIRE_KIND, 'fired', 2),
      row('2026-09-01', 'green_checkpoint', 'brand-new-status', 2),
    ]);
    const days = await reconstructGateFireDays(sql, target, { sinceDays: 5 });
    expect(days[0].unknown).toBe(2);
    expect(days[0].unknownStatuses).toEqual(['brand-new-status']);
  });

  it('matches identified fires to distinct terminal outcomes, excluding pending and duplicate rows', async () => {
    const { sql } = makeCaptureSql([
      { day: '2026-09-02', kind: GATE_FIRE_KIND, status: 'fired', gate_fire_id: 'fire-a', n: '1' },
      { day: '2026-09-02', kind: GATE_FIRE_KIND, status: 'fired', gate_fire_id: 'fire-b', n: '1' },
      { day: '2026-09-02', kind: 'green_checkpoint', status: 'decision-pending', gate_fire_id: 'fire-a', n: '1' },
      { day: '2026-09-02', kind: 'green_checkpoint', status: 'not-green', gate_fire_id: 'fire-a', n: '1' },
      // A second terminal row for fire-a must not satisfy fire-b.
      { day: '2026-09-02', kind: 'green_checkpoint', status: 'advanced', gate_fire_id: 'fire-a', n: '1' },
      { day: '2026-09-02', kind: 'green_checkpoint', status: 'decision-pending', gate_fire_id: 'fire-b', n: '1' },
      { day: '2026-09-02', kind: 'green_checkpoint', status: 'release-fixer-skipped-stale', gate_fire_id: 'fire-b', n: '1' },
    ]);

    const [day] = await reconstructGateFireDays(sql, target, { sinceDays: 5 });

    expect(day).toMatchObject({
      fires: 2,
      outcomes: 5,
      terminalOutcomes: 2,
      pending: 2,
      unaccounted: 1,
    });
  });

  it('sorts days ascending across a multi-day window', async () => {
    const { sql } = makeCaptureSql([
      row('2026-08-31', GATE_FIRE_KIND, 'fired', 3),
      row('2026-08-30', 'green_checkpoint', 'advanced', 1),
    ]);
    const days = await reconstructGateFireDays(sql, target, {});
    expect(days.map((d) => d.day)).toEqual(['2026-08-30', '2026-08-31']);
  });
});
