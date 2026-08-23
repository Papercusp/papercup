/**
 * Read-side completion freshness/oracle-drift detection.
 *
 * The detector compares the server-stamped terminal evidence with a fresh
 * spawn-free HEAD observation.  These tests pin the three honest outcomes:
 * current, changed, and not observable.
 */
import { describe, expect, it, vi } from 'vitest';
import { completionFreshnessForEvidence } from './completion-freshness';

const stored = { repositoryRoot: '/repo', headSha: 'a'.repeat(40) } as const;
const current = { repositoryRoot: '/repo', headSha: 'b'.repeat(40) } as const;

describe('completionFreshnessForEvidence (EI-21259433290500193)', () => {
  it('returns no signal when terminal evidence has no valid tree stamp', () => {
    expect(completionFreshnessForEvidence({ verifiedHow: 'unit' })).toBeUndefined();
    expect(completionFreshnessForEvidence({ treeStamp: { repositoryRoot: '/repo', headSha: 'short' } })).toBeUndefined();
  });

  it('reports fresh when the stored and current stamps match', () => {
    const currentStamp = vi.fn(() => stored);

    const result = completionFreshnessForEvidence(
      { treeStamp: stored },
      { currentStamp },
    );

    expect(currentStamp).toHaveBeenCalledWith(stored);
    expect(result).toMatchObject({
      verdict: 'fresh',
      storedTreeStamp: stored,
      currentTreeStamp: stored,
    });
  });

  it('reports stale when a peer advanced the same repository HEAD', () => {
    const result = completionFreshnessForEvidence(
      { treeStamp: stored },
      { currentStamp: () => current },
    );

    expect(result).toMatchObject({
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: current,
    });
    expect(result?.reason).toMatch(/re-verify/);
  });

  it('reports unavailable rather than falsely calling evidence fresh', () => {
    const result = completionFreshnessForEvidence(
      { treeStamp: stored },
      { currentStamp: () => undefined },
    );

    expect(result).toMatchObject({ verdict: 'unavailable', storedTreeStamp: stored });
    expect(result?.currentTreeStamp).toBeUndefined();
    expect(result?.reason).toMatch(/not established/);
  });

  it('is fail-soft when the injected current-stamp probe throws', () => {
    const result = completionFreshnessForEvidence(
      { treeStamp: stored },
      {
        currentStamp: () => {
          throw new Error('EIO');
        },
      },
    );

    expect(result?.verdict).toBe('unavailable');
  });
});
