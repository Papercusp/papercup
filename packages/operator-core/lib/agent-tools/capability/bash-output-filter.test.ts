/**
 * capability:bash_output `filter` regex (agent-capability-confinement P-031 — schema
 * parity with the native BashOutput tool). Pure unit tests over filterOutputLines —
 * no subprocess, deterministic.
 */
import { describe, it, expect } from 'vitest';
import { formatJobLogEndMarker } from './bash-jobs';
import { filterOutputLines, inspectStrandedJobLog } from './bash_output';
import { parseJobLogEndMarker } from '../../task-manager/job-log-terminal';

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

  describe('leading PCRE-style bare inline-flag prefix (EI-22076120901648689)', () => {
    it('(?i) applies case-insensitive matching instead of throwing "Invalid group"', () => {
      const r = filterOutputLines(chunk, '(?i)APPLE');
      expect(r.error).toBeUndefined();
      expect(r.output).toBe('apple');
    });

    it('(?im) composes case-insensitive with multiline anchors', () => {
      const multiline = 'Line One\nline two\nLINE THREE';
      const r = filterOutputLines(multiline, '(?im)^line');
      expect(r.error).toBeUndefined();
      expect(r.output).toBe(multiline); // every line matches case-insensitively
    });

    it('a bare (?i) with nothing after it matches every line (empty pattern, i flag applied)', () => {
      const r = filterOutputLines(chunk, '(?i)');
      expect(r.error).toBeUndefined();
      expect(r.output).toBe(chunk);
    });

    it('an unsupported PCRE flag letter (e.g. x) falls through to the ordinary invalid-regex path', () => {
      const r = filterOutputLines(chunk, '(?x)apple');
      // JS has no `x` (free-spacing) flag and no bare-group syntax either way,
      // so this must still degrade gracefully rather than throw uncaught.
      expect(r.output).toBe(chunk);
      expect(r.error).toMatch(/invalid filter regex/);
    });

    it('a mid-pattern (?i:...) group (not a leading bare prefix) is left untouched — never crashes the tool', () => {
      // Not the reported failure shape; only a LEADING bare `(?i)` prefix is special-cased,
      // since PCRE_INLINE_FLAGS_PREFIX requires ')' immediately after the flag letters.
      // Whether the runtime's RegExp engine accepts the `(?i:...)` group form varies by
      // Node version — the contract this asserts is only that filterOutputLines still
      // never throws, per its documented "never throws or hangs" guarantee.
      expect(() => filterOutputLines(chunk, 'a(?i:PP)le')).not.toThrow();
    });

    it('is still subject to the ReDoS/length guards ahead of flag stripping', () => {
      const r = filterOutputLines(chunk, '(?i)' + 'a'.repeat(201));
      expect(r.output).toBe(chunk);
      expect(r.error).toMatch(/too long/);
    });
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
