import { describe, expect, it } from 'vitest';

// The fixtures are PRINTED by the real writer-side formatters, not hand-copied, so a format
// change in scripts/lib/test-pass-reuse.mjs breaks this test instead of silently blinding the
// gate-side parser.
import {
  formatReuseAlarmLine,
  formatTestReuseLine,
  formatTestReuseTotalLine,
} from '../../../../scripts/lib/test-pass-reuse.mjs';
import {
  formatDurationMs,
  parseTestPassReuse,
  parseTestPassReuseHealth,
  summarizeTestPassReuse,
} from './test-pass-reuse-report';

const summary = (over: Record<string, number> = {}) => ({
  candidates: 10,
  reused: 7,
  noProof: 1,
  otherContext: 0,
  otherRunner: 0,
  expired: 1,
  notCaptured: 0,
  opaque: 0,
  unknownDrift: 0,
  globalInput: 0,
  inputChanged: 1,
  audited: 0,
  expiredClean: 0,
  ...over,
});

describe('parseTestPassReuse', () => {
  it('reads one applied invocation: per-task lines, the total, and later alarms', () => {
    const a = summary();
    const b = summary({ candidates: 4, reused: 4, noProof: 0, expired: 0, inputChanged: 0 });
    const output = [
      'AFFECTED_DERIVATION source=explicit changedPaths=1',
      formatTestReuseLine('@papercusp/operator-core', a, ' rows=900 narrowed=true minSavedTestMs=61000'),
      formatTestReuseLine('@papercusp/web', b, ' rows=40 narrowed=false minSavedTestMs=5000'),
      formatTestReuseTotalLine({ tasks: 2, summaries: [a, b], savedMs: 66000, unmeasured: 2 }),
      ' RUN  v4.1.8 /repo/packages/operator-core',
      formatReuseAlarmLine('@papercusp/operator-core', { file: 'lib/x.test.ts', reason: 'expired' }),
    ].join('\n');

    const runs = parseTestPassReuse(output);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run!.applied).toBe(true);
    expect(run!.workspaces.map((w) => w.ws)).toEqual(['@papercusp/operator-core', '@papercusp/web']);
    expect(run!.workspaces[0]!.counts).toMatchObject({ candidates: 10, reused: 7, expired: 1, rows: 900 });
    expect(run!.workspaces[0]!.narrowed).toBe(true);
    expect(run!.workspaces[1]!.narrowed).toBe(false);
    expect(run!.workspaces[0]!.minSavedTestMs).toBe(61000);
    expect(run!.total).toEqual({
      tasks: 2,
      candidates: 14,
      reused: 11,
      audited: 0,
      expiredClean: 0,
      minSavedTestMs: 66000,
      unmeasured: 2,
    });
    expect(run!.alarms).toEqual([
      { ws: '@papercusp/operator-core', file: 'lib/x.test.ts', proof: 'expired' },
    ]);
  });

  it('keeps an unknown saving as null, never as zero', () => {
    const a = summary();
    const runs = parseTestPassReuse(
      formatTestReuseTotalLine({ tasks: 1, summaries: [a], savedMs: null, unmeasured: 0 }),
    );
    expect(runs[0]!.total!.minSavedTestMs).toBeNull();
    expect(summarizeTestPassReuse(runs).minSavedTestMs).toBeNull();
    expect(summarizeTestPassReuse(runs).headline).toContain('test time saved unknown');
  });

  it('reads a whole-run off line and a per-task off line with a reason that has punctuation', () => {
    const output = [
      '[green-checkpoint] TEST_PASS_REUSE applied=false reason=dirty-checkout',
      'TEST_PASS_REUSE ws=@papercusp/web applied=false reason=proofs-unavailable(connect ECONNREFUSED 127.0.0.1:5432)',
      formatTestReuseTotalLine({ tasks: 1, summaries: [], savedMs: 0, unmeasured: 0 }),
    ].join('\n');
    const runs = parseTestPassReuse(output);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ applied: false, offReason: 'dirty-checkout', workspaces: [] });
    expect(runs[1]!.workspaces[0]).toMatchObject({
      ws: '@papercusp/web',
      applied: false,
      reason: 'proofs-unavailable(connect ECONNREFUSED 127.0.0.1:5432)',
    });
  });

  it('splits two concatenated invocations (selective phase, then full phase)', () => {
    const a = summary();
    const b = summary({ candidates: 800, reused: 790 });
    const output = [
      formatTestReuseLine('@papercusp/operator-core', a, ' minSavedTestMs=1000'),
      formatTestReuseTotalLine({ tasks: 1, summaries: [a], savedMs: 1000, unmeasured: 0 }),
      formatTestReuseLine('@papercusp/operator-core', b, ' minSavedTestMs=900000'),
      formatTestReuseTotalLine({ tasks: 1, summaries: [b], savedMs: 900000, unmeasured: 3 }),
    ].join('\n');
    const runs = parseTestPassReuse(output);
    expect(runs.map((r) => r.total?.reused)).toEqual([7, 790]);
    const s = summarizeTestPassReuse(runs);
    expect(s).toMatchObject({ invocations: 2, candidates: 810, reused: 797, minSavedTestMs: 901000, unmeasured: 3 });
    expect(s.headline).toBe(
      'per-file reuse: 797 of 810 candidate file(s) reused, at least 15m 01s test time saved (3 file(s) unmeasured), no alarms',
    );
  });

  it('ignores lookalike text and reports a round with no reuse lines as not reported', () => {
    const output = 'TEST_PASS_REUSE_TOTALLY not a line\nsome TEST_PASS_REUSE ws=x mid-line mention';
    const runs = parseTestPassReuse(output);
    expect(runs).toEqual([]);
    expect(summarizeTestPassReuse(runs).headline).toBe('per-file reuse: not reported by this round');
  });
});

describe('summarizeTestPassReuse', () => {
  it('names alarms and per-task off reasons in the headline', () => {
    const a = summary();
    const output = [
      formatTestReuseLine('@papercusp/operator-core', a, ' minSavedTestMs=30000'),
      'TEST_PASS_REUSE ws=@papercusp/web applied=false reason=proofs-unavailable(timeout)',
      formatTestReuseTotalLine({ tasks: 1, summaries: [a], savedMs: 30000, unmeasured: 0 }),
      formatReuseAlarmLine('@papercusp/operator-core', { file: 'lib/y.test.ts', reason: 'notCaptured' }),
    ].join('\n');
    const s = summarizeTestPassReuse(parseTestPassReuse(output));
    expect(s.alarms).toHaveLength(1);
    expect(s.offReasons).toEqual(['proofs-unavailable(timeout)']);
    expect(s.headline).toBe(
      'per-file reuse: 7 of 10 candidate file(s) reused, at least 30s test time saved, 1 ALARM(s); ' +
        'off for some tasks: proofs-unavailable(timeout)',
    );
  });

  it('reports a fully-off round by its reasons', () => {
    const s = summarizeTestPassReuse(
      parseTestPassReuse('TEST_PASS_REUSE applied=false reason=disabled-by-env'),
    );
    expect(s.headline).toBe('per-file reuse off: disabled-by-env');
  });
});

describe('parseTestPassReuseHealth', () => {
  const persisted = () => ({
    judgedSha: 'c58655490ce1a3be734de61df08aa7f8159122d4',
    recordedAtMs: 1_790_530_000_000,
    ...summarizeTestPassReuse(
      parseTestPassReuse(
        [
          formatTestReuseLine('@papercusp/operator-core', summary(), ' minSavedTestMs=30000'),
          formatTestReuseTotalLine({ tasks: 1, summaries: [summary()], savedMs: 30000, unmeasured: 0 }),
          formatReuseAlarmLine('@papercusp/operator-core', { file: 'lib/y.test.ts', reason: 'expired' }),
        ].join('\n'),
      ),
    ),
  });

  it('round-trips a persisted summary through JSON', () => {
    const blob = JSON.parse(JSON.stringify(persisted()));
    expect(parseTestPassReuseHealth(blob)).toEqual(persisted());
  });

  it('keeps a null saving', () => {
    expect(parseTestPassReuseHealth({ ...persisted(), minSavedTestMs: null })?.minSavedTestMs).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an array', []],
    ['a bad sha', { ...persisted(), judgedSha: 'main' }],
    ['a negative count', { ...persisted(), reused: -1 }],
    ['a string saving', { ...persisted(), minSavedTestMs: '30000' }],
    ['a malformed alarm', { ...persisted(), alarms: [{ ws: 'x' }] }],
    ['an empty headline', { ...persisted(), headline: '' }],
  ])('reads %s as not measured', (_label, value) => {
    expect(parseTestPassReuseHealth(value)).toBeNull();
  });
});

describe('formatDurationMs', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDurationMs(4_400)).toBe('4s');
    expect(formatDurationMs(61_000)).toBe('1m 01s');
    expect(formatDurationMs(3_720_000)).toBe('1h 02m');
  });
});
