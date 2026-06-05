/**
 * Unit coverage for the issue → F-FIX promotion helpers (P-011 / D-016):
 *   - selectConvertCandidates: which issues the automated sweep auto-promotes
 *     (open + critical|major + unlinked) vs. which stay human-only.
 *   - withHarnessSweepLock: the in-process per-harness mutex that makes the
 *     30s-tick + on-settle-refill DOUBLE-FIRE idempotent (the second concurrent
 *     sweep for a key skips instead of double-minting).
 *
 * The PG/FS-touching paths (mintFixFeatureRow / convertOpenIssuesToFeatures)
 * are exercised by integration coverage; these unit tests pin the two
 * correctness-critical decisions in isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  selectConvertCandidates,
  withHarnessSweepLock,
  __resetSweepLocksForTest,
} from './promote-issue';
import type { Issue, IssueSeverity, IssueStatus } from './harness/issue-types';

function issue(over: Partial<Issue>): Issue {
  return {
    id: 'I-0001',
    title: 'something broke',
    severity: 'major',
    source: 'validator',
    foundAt: '2026-06-01T00:00:00.000Z',
    status: 'open',
    attempts: 0,
    notes: [],
    ...over,
  };
}

/** Defer: a promise plus its resolver, for deterministic concurrency control. */
function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('selectConvertCandidates', () => {
  it('includes open critical and major issues with no linked feature', () => {
    const issues = [
      issue({ id: 'I-1', severity: 'critical' }),
      issue({ id: 'I-2', severity: 'major' }),
    ];
    expect(selectConvertCandidates(issues).map((i) => i.id)).toEqual(['I-1', 'I-2']);
  });

  it('excludes minor and nit severities (human-promote-only)', () => {
    const issues = [
      issue({ id: 'I-1', severity: 'minor' }),
      issue({ id: 'I-2', severity: 'nit' }),
    ];
    expect(selectConvertCandidates(issues)).toEqual([]);
  });

  it('excludes already-linked issues (the dedup guard)', () => {
    const issues = [issue({ id: 'I-1', severity: 'critical', linkedFeatureId: 'F-FIX-001' })];
    expect(selectConvertCandidates(issues)).toEqual([]);
  });

  it('excludes non-open statuses', () => {
    const statuses: IssueStatus[] = ['acknowledged', 'fixing', 'closed', 'wontfix'];
    const issues = statuses.map((status, n) => issue({ id: `I-${n}`, severity: 'critical', status }));
    expect(selectConvertCandidates(issues)).toEqual([]);
  });

  it('filters a mixed set down to exactly the eligible issues', () => {
    const severities: IssueSeverity[] = ['critical', 'major', 'minor', 'nit'];
    const issues = severities.map((severity, n) => issue({ id: `I-${n}`, severity }));
    issues.push(issue({ id: 'I-linked', severity: 'critical', linkedFeatureId: 'F-FIX-001' }));
    issues.push(issue({ id: 'I-closed', severity: 'major', status: 'closed' }));
    expect(selectConvertCandidates(issues).map((i) => i.id)).toEqual(['I-0', 'I-1']);
  });
});

describe('withHarnessSweepLock (double-fire idempotency)', () => {
  beforeEach(() => __resetSweepLocksForTest());
  afterEach(() => __resetSweepLocksForTest());

  it('skips a concurrent sweep for the same key while one is in flight', async () => {
    const gate = defer();
    let firstRuns = 0;
    let secondRuns = 0;

    const first = withHarnessSweepLock('ws:papercup', async () => {
      firstRuns++;
      await gate.promise; // hold the lock open
      return 'first';
    });

    // While `first` is still awaiting the gate, a second call for the SAME key
    // must skip — NOT run fn, NOT queue.
    const second = await withHarnessSweepLock('ws:papercup', async () => {
      secondRuns++;
      return 'second';
    });
    expect(second).toEqual({ skipped: true });
    expect(secondRuns).toBe(0);

    gate.resolve();
    expect(await first).toBe('first');
    expect(firstRuns).toBe(1);
  });

  it('runs again for the same key after the in-flight sweep settles', async () => {
    expect(await withHarnessSweepLock('ws:papercup', async () => 'a')).toBe('a');
    // lock released → a fresh call runs, not skipped
    expect(await withHarnessSweepLock('ws:papercup', async () => 'b')).toBe('b');
  });

  it('does not block different keys from running concurrently', async () => {
    const gate = defer();
    let bRan = false;

    const a = withHarnessSweepLock('ws:harnessA', async () => {
      await gate.promise;
      return 'a';
    });
    const b = await withHarnessSweepLock('ws:harnessB', async () => {
      bRan = true;
      return 'b';
    });
    expect(b).toBe('b');
    expect(bRan).toBe(true);

    gate.resolve();
    expect(await a).toBe('a');
  });

  it('releases the lock even when fn throws', async () => {
    await expect(
      withHarnessSweepLock('ws:papercup', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // lock must be freed despite the throw → next call runs
    expect(await withHarnessSweepLock('ws:papercup', async () => 'ok')).toBe('ok');
  });
});
