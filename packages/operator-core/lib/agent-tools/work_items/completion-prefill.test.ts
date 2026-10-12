import { describe, expect, it } from 'vitest';
import type { WorkItemMechanics } from './_mechanics';
import { completionSuppliesField, prefillCompletionFromMechanics } from './completion-prefill';

const verificationOf = (c: object) => (c as { verification?: Record<string, unknown> }).verification ?? {};

function mechanics(over: Partial<WorkItemMechanics> = {}): WorkItemMechanics {
  return {
    derived: 'read-time',
    derivedAt: '2026-10-12T17:00:00.000Z',
    holder: { ownerId: 'su-a', claimedAt: '2026-10-12T16:00:00.000Z' },
    filesWritten: { paths: ['lib/a.ts', 'lib/a.test.ts'], total: 2, truncated: false, outsideRepo: 0 },
    tests: {
      attribution: 'path-and-claim-window',
      latest: [
        {
          file: 'lib/a.test.ts',
          status: 'pass',
          at: '2026-10-12T16:30:00.000Z',
          passed: 4,
          failed: 0,
          dirtyTree: true,
          commitSha: 'ec4366d0843c68dc1ad481a9b86ab476186b6ca8',
        },
      ],
      verdict: 'all-pass',
    },
    openBlockers: [],
    sources: [],
    ...over,
  };
}

describe('completion prefill — fills absent fields from the ledgers', () => {
  it('fills filesChanged, testsRun and testResult when the completion omits all three', () => {
    const { completion, prefill } = prefillCompletionFromMechanics({ summary: 'done' } as Record<string, unknown>, mechanics());
    const v = verificationOf(completion);
    expect(v.filesChanged).toEqual(['lib/a.ts', 'lib/a.test.ts']);
    expect(v.testsRun).toContain('lib/a.test.ts');
    expect(v.testResult).toMatch(/^all passing — lib\/a\.test\.ts: pass \(4 passed\) @ ec4366d084\+dirty/);
    expect(prefill?.fields).toEqual(['filesChanged', 'testsRun', 'testResult']);
    expect(prefill?.attribution).toBe('path-and-claim-window');
  });

  it('lists filesChanged among the prefilled fields when only edits exist', () => {
    const m = mechanics({ tests: { attribution: 'path-and-claim-window', latest: [], verdict: 'none' } });
    const { completion, prefill } = prefillCompletionFromMechanics({}, m);
    expect(verificationOf(completion).filesChanged).toEqual(['lib/a.ts', 'lib/a.test.ts']);
    expect(prefill?.fields).toEqual(['filesChanged']);
  });

  it('reports a failing run as FAILING, never as passing', () => {
    const m = mechanics({
      tests: {
        attribution: 'path-and-claim-window',
        latest: [{ file: 'lib/a.test.ts', status: 'fail', at: null, passed: 3, failed: 1, dirtyTree: false, commitSha: null }],
        verdict: 'failing',
      },
    });
    const { completion, prefill } = prefillCompletionFromMechanics({}, m);
    expect(verificationOf(completion).testResult).toMatch(/^FAILING — lib\/a\.test\.ts: fail \(3 passed, 1 failed\)/);
    expect(prefill?.testVerdict).toBe('failing');
  });

  it('discloses a capped filesChanged list as truncated', () => {
    const m = mechanics({ filesWritten: { paths: ['a.ts'], total: 41, truncated: true, outsideRepo: 0 } });
    const { prefill } = prefillCompletionFromMechanics({}, m);
    expect(prefill?.filesChangedTruncated).toEqual({ listed: 1, total: 41 });
  });
});

describe('completion prefill — never overrides a supplied value', () => {
  it('keeps nested values and fills only the absent field', () => {
    const input = { verification: { filesChanged: ['mine.ts'], testsRun: 'npm run test:file -- x' } };
    const { completion, prefill } = prefillCompletionFromMechanics(input, mechanics());
    const v = verificationOf(completion);
    expect(v.filesChanged).toEqual(['mine.ts']);
    expect(v.testsRun).toBe('npm run test:file -- x');
    expect(v.testResult).toMatch(/^all passing/);
    expect(prefill?.fields).toEqual(['testResult']);
  });

  it('treats legacy top-level aliases as supplied values', () => {
    const input = { filesChanged: ['legacy.ts'], tests: 'ran it', testResult: '4 passed' };
    const { completion, prefill } = prefillCompletionFromMechanics(input, mechanics());
    expect(prefill).toBeNull();
    expect(completion).toBe(input);
  });

  it('does not mutate the caller object', () => {
    const input: Record<string, unknown> = { verification: { verifiedHow: 'unit' } };
    prefillCompletionFromMechanics(input, mechanics());
    expect(input).toEqual({ verification: { verifiedHow: 'unit' } });
  });

  it('returns null and the same object when there is no claim window', () => {
    const input = { summary: 'x' };
    const { completion, prefill } = prefillCompletionFromMechanics(input, null);
    expect(prefill).toBeNull();
    expect(completion).toBe(input);
  });

  it('a whitespace-only string is absent; an empty list is absent', () => {
    expect(completionSuppliesField({ testsRun: '  ' }, 'testsRun')).toBe(false);
    expect(completionSuppliesField({ verification: { filesChanged: [] } }, 'filesChanged')).toBe(false);
    expect(completionSuppliesField({ verification: { testResult: 'ok' } }, 'testResult')).toBe(true);
  });
});
