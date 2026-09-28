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
  formatExecutedMapAlarmLines,
  formatExecutedMapResultLines,
  formatExecutedMapTotalLine,
  readExecutedMapResults,
  summarizeExecutedMapResults,
} from '../../../../scripts/lib/executed-source-map.mjs';
import {
  buildTestPassReuseHealth,
  formatDurationMs,
  parseTestPassReuse,
  parseTestPassReuseHealth,
  summarizeExecutedSourceMapRecorder,
  summarizeTestPassReuse,
  TEST_PASS_REUSE_HEALTH_MAX_ALARMS,
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

describe('buildTestPassReuseHealth (P-013 runner half)', () => {
  const sha = 'c58655490ce1a3be734de61df08aa7f8159122d4';
  const suiteOutput = (alarmCount = 1) =>
    [
      formatTestReuseLine('@papercusp/operator-core', summary(), ' minSavedTestMs=30000'),
      formatTestReuseTotalLine({ tasks: 1, summaries: [summary()], savedMs: 30000, unmeasured: 0 }),
      ...Array.from({ length: alarmCount }, (_, i) =>
        formatReuseAlarmLine('@papercusp/operator-core', { file: `lib/a${i}.test.ts`, reason: 'expired' }),
      ),
    ].join('\n');

  it('builds the record the recorder stores, and it survives the JSON verdict channel', () => {
    const built = buildTestPassReuseHealth(suiteOutput(), sha, 1_790_530_000_000);
    expect(built).toMatchObject({ judgedSha: sha, recordedAtMs: 1_790_530_000_000, reused: 7, candidates: 10 });
    expect(built?.headline).toContain('7 of 10 candidate file(s) reused');
    // The version-skew fallback reads it back out of JSON; the read-side check must accept it.
    expect(parseTestPassReuseHealth(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it('caps stored alarms but keeps the full count in the headline', () => {
    const n = TEST_PASS_REUSE_HEALTH_MAX_ALARMS + 5;
    const built = buildTestPassReuseHealth(suiteOutput(n), sha, 1);
    expect(built?.alarms).toHaveLength(TEST_PASS_REUSE_HEALTH_MAX_ALARMS);
    expect(built?.headline).toContain(`${n} ALARM(s)`);
  });

  it.each([
    ['a round with no reuse lines', 'plain vitest output only', sha],
    ['a null sha', null, null],
    ['a branch name instead of a sha', null, 'main'],
  ])('returns null (not reported, never zero) for %s', (_label, output, judged) => {
    expect(buildTestPassReuseHealth(output ?? suiteOutput(), judged, 1)).toBeNull();
  });
});

describe('formatDurationMs', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDurationMs(4_400)).toBe('4s');
    expect(formatDurationMs(61_000)).toBe('1m 01s');
    expect(formatDurationMs(3_720_000)).toBe('1h 02m');
  });
});

// WI-10003603: a recorder that failed every write (WI-10003597) left reuse at zero for ~8h because
// its outcome only reached discarded task stderr. The runner now prints it; these fixtures are
// produced by the RUNNER's own reader + formatters from the reporter's result-file lines, so the
// whole chain (reporter line → runner read → printed line → gate parse) is exercised end to end.
describe('pass-proof recorder outcome (WI-10003603)', () => {
  type Line = { outcome: string; rows: number; retired?: number; skipped?: number; dirty?: boolean; error?: string | null };
  const resultFile = (lines: Line[]) =>
    lines
      .map((l) =>
        JSON.stringify({
          workspaceName: 'w',
          retired: 0,
          skipped: 0,
          dirty: false,
          sha: 'c0ffee000000',
          error: null,
          ...l,
        }),
      )
      .join('\n');
  /** One affected-tests invocation's recorder output, as the runner prints it. */
  const printed = (tasks: Record<string, Line[] | null>) => {
    const reads = Object.entries(tasks).map(([task, lines]) => ({
      task,
      read: readExecutedMapResults('/unused', {
        readFile: () => {
          if (lines === null) throw new Error('ENOENT');
          return resultFile(lines);
        },
      }),
    }));
    return [
      ...reads.flatMap(({ task, read }) => [
        ...formatExecutedMapResultLines(task, read),
        ...formatExecutedMapAlarmLines(task, read),
      ]),
      formatExecutedMapTotalLine(summarizeExecutedMapResults(reads.map((r) => r.read))),
    ].join('\n');
  };

  it('is NOT REPORTED (null) when the round printed no recorder total — never "recorded nothing"', () => {
    expect(summarizeExecutedSourceMapRecorder('TEST_PASS_REUSE applied=false reason=off')).toBeNull();
  });

  it('reads a healthy round as recorded, with rows summed over invocations', () => {
    const out = [
      printed({ 'a::test': [{ outcome: 'written', rows: 40 }], 'b::test:lane-pure': [{ outcome: 'nothing-to-record', rows: 0 }] }),
      printed({ 'c::test': [{ outcome: 'written', rows: 2, retired: 1 }] }),
    ].join('\n');
    const r = summarizeExecutedSourceMapRecorder(out)!;
    expect(r).toMatchObject({ invocations: 2, tasks: 3, written: 2, rows: 42, retired: 1, nothingToRecord: 1 });
    expect(r.verdict).toBe('recorded');
    expect(r.alarm).toBe(false);
  });

  it('ALARMS on a failing writer and carries its error — the WI-10003597 round', () => {
    const out = printed({
      '@papercusp/operator-core::test': [{ outcome: 'failed', rows: 900, error: 'cannot cast type boolean to\nboolean[]' }],
      'x::test': [{ outcome: 'timed-out', rows: 3 }],
    });
    const r = summarizeExecutedSourceMapRecorder(out)!;
    expect(r).toMatchObject({ verdict: 'write-failing', alarm: true, failed: 1, timedOut: 1, written: 0 });
    expect(r.alarms[0]).toEqual({
      task: '@papercusp/operator-core::test',
      outcome: 'failed',
      error: 'cannot cast type boolean to boolean[]',
    });
    const health = buildTestPassReuseHealth(out, 'abcdef1234567', 1)!;
    expect(health.headline).toContain('PASS-PROOF RECORDER FAILING: 1 write(s) failed, 1 timed out');
    expect(health.headline).toContain('cannot cast type boolean to boolean[]');
  });

  it('ALARMS when the clean round persisted nothing, or no task reported at all', () => {
    const dirty = summarizeExecutedSourceMapRecorder(printed({ 'a::test': [{ outcome: 'not-persisted', rows: 5, dirty: true }] }))!;
    expect(dirty).toMatchObject({ verdict: 'not-persisted', alarm: true });
    const silent = summarizeExecutedSourceMapRecorder(printed({ 'a::test': null, 'b::test': null }))!;
    expect(silent).toMatchObject({ verdict: 'unreported', alarm: true, noReport: 2 });
    const quiet = summarizeExecutedSourceMapRecorder(printed({ 'a::test:lane-pure': [{ outcome: 'nothing-to-record', rows: 0 }] }))!;
    expect(quiet).toMatchObject({ verdict: 'nothing-to-record', alarm: false });
  });

  it('builds a health record from recorder lines alone, and round-trips it through the parser', () => {
    const out = printed({ 'a::test': [{ outcome: 'failed', rows: 1, error: 'db down' }] });
    const built = buildTestPassReuseHealth(out, 'abcdef1234567', 7)!;
    expect(built.recorder?.verdict).toBe('write-failing');
    expect(built.headline).toMatch(/^per-file reuse: not reported by this round; PASS-PROOF RECORDER FAILING/);
    expect(parseTestPassReuseHealth(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it('keeps the reuse record when a persisted recorder is malformed, reading only the recorder as unreported', () => {
    const built = buildTestPassReuseHealth(printed({ 'a::test': [{ outcome: 'written', rows: 1 }] }), 'abcdef1234567', 7)!;
    const parsed = parseTestPassReuseHealth({ ...built, recorder: { verdict: 'recorded' } });
    expect(parsed).not.toBeNull();
    expect(parsed!.recorder).toBeNull();
    expect(parseTestPassReuseHealth({ ...built, recorder: undefined })!.recorder).toBeNull();
  });
});
