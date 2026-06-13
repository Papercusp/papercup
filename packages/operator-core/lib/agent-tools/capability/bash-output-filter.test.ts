/**
 * capability:bash_output `filter` regex (agent-capability-confinement P-031 — schema
 * parity with the native BashOutput tool). Pure unit tests over filterOutputLines —
 * no subprocess, deterministic.
 */
import { describe, it, expect } from 'vitest';
import { filterOutputLines } from './bash_output';

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
