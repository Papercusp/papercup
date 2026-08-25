/**
 * capability:bash_output `filter` regex (agent-capability-confinement P-031 — schema
 * parity with the native BashOutput tool). Pure unit tests over filterOutputLines —
 * no subprocess, deterministic.
 */
import { describe, it, expect } from 'vitest';
import { formatJobLogEndMarker } from './bash-jobs';
import { filterOutputLines, inspectStrandedJobLog, parseJobLogEndMarker } from './bash_output';

describe('filterOutputLines', () => {
  const chunk = 'apple\nbanana\napricot\ncherry';

  it('no filter → unchanged chunk', () => {
    expect(filterOutputLines(chunk, undefined)).toEqual({ output: chunk });
    expect(filterOutputLines(chunk, '')).toEqual({ output: chunk });
  });

  it('keeps only matching lines (cursor semantics are the caller’s job)', () => {
    expect(filterOutputLines(chunk, '^ap').output).toBe('apple\napricot');
    expect(filterOutputLines(chunk, 'rr').output).toBe('cherry');
    expect(filterOutputLines(chunk, 'z').output).toBe('');
  });

  it('supports regex syntax', () => {
    expect(filterOutputLines(chunk, 'a(pp|pr)').output).toBe('apple\napricot');
  });

  it('an invalid regex does NOT throw — returns the unfiltered chunk + an error note', () => {
    const r = filterOutputLines(chunk, '(unclosed');
    expect(r.output).toBe(chunk);
    expect(r.error).toMatch(/invalid filter regex/);
  });

  it('rejects ReDoS-prone nested-quantifier patterns (runs in the shared operator process)', () => {
    for (const evil of ['(a+)+', '(.*)*', '(a{2,})+', '(.+){8}', '(ab*)+$']) {
      const r = filterOutputLines(chunk, evil);
      expect(r.output).toBe(chunk); // unfiltered (not applied)
      expect(r.error, `${evil} must be rejected`).toMatch(/ReDoS/);
    }
  });

  it('rejects an over-long filter (length-cap bound on the ReDoS surface)', () => {
    const r = filterOutputLines(chunk, 'a'.repeat(201));
    expect(r.output).toBe(chunk);
    expect(r.error).toMatch(/too long/);
  });

  it('still accepts ordinary anchored/alternation patterns (the guard is not over-broad)', () => {
    expect(filterOutputLines(chunk, '^a').error).toBeUndefined();
    expect(filterOutputLines(chunk, 'a(pp|pr)').error).toBeUndefined();
    expect(filterOutputLines(chunk, 'err|warn|fail').error).toBeUndefined();
  });
});

describe('stranded job log recovery (EI-20230176152308336)', () => {
  const log =
    'noise\nTests 111 passed\nEXIT=0\n' +
    formatJobLogEndMarker('completed', 0, Date.UTC(2026, 7, 12, 7, 6, 45));

  it('parses a durable JOB END marker as a terminal verdict', () => {
    expect(parseJobLogEndMarker(log)).toEqual({ status: 'completed', exitCode: 0 });
  });

  it('uses the last marker when the durable runner raw verdict is superseded by the operator-normalized verdict', () => {
    const dualMarkerLog =
      'payload output\n' +
      formatJobLogEndMarker('completed', 0, Date.UTC(2026, 7, 12, 7, 6, 45)) +
      'operator diagnostics\n' +
      formatJobLogEndMarker('failed', 127, Date.UTC(2026, 7, 12, 7, 6, 46));

    expect(parseJobLogEndMarker(dualMarkerLog)).toEqual({ status: 'failed', exitCode: 127 });
  });

  it('returns the terminal verdict and applies filter to the recovered tail', () => {
    const recovered = inspectStrandedJobLog(log, '^(Tests|EXIT=)');
    expect(recovered.terminal).toEqual({ status: 'completed', exitCode: 0 });
    expect(recovered.output).toBe('Tests 111 passed\nEXIT=0');
    expect(recovered.output).not.toContain('noise');
    expect(recovered.output).not.toContain('JOB END');
    expect(recovered.filterError).toBeUndefined();
  });

  it('keeps liveness unresolved when the marker is absent while still filtering output', () => {
    const recovered = inspectStrandedJobLog('still running\nTests 111 passed\n', 'Tests');
    expect(recovered.terminal).toBeNull();
    expect(recovered.output).toBe('Tests 111 passed');
  });
});
