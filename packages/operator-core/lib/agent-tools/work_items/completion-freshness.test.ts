/**
 * Read-side completion freshness/oracle-drift detection.
 *
 * The detector compares the server-stamped terminal evidence with a fresh
 * spawn-free HEAD observation.  These tests pin the three honest outcomes:
 * current, changed, and not observable.
 */
import { describe, expect, it, vi } from 'vitest';
import { completionFreshnessForEvidence, completionTreeContentIdentityMatches } from './completion-freshness';
import type { CompletionTreeContentIdentity } from '../../coord-lifecycle/records';

const identity: CompletionTreeContentIdentity[] = [
  { path: 'src/fix.ts', workingTreeBlobSha: 'c'.repeat(40), headBlobSha: 'c'.repeat(40) },
];
const stored = { repositoryRoot: '/repo', headSha: 'a'.repeat(40), contentIdentity: identity };
const current = { repositoryRoot: '/repo', headSha: 'b'.repeat(40), contentIdentity: identity };

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

  it('reports fresh when a peer advanced HEAD without changing declared path content', () => {
    const result = completionFreshnessForEvidence(
      { treeStamp: stored },
      { currentStamp: () => current },
    );

    expect(result).toMatchObject({
      verdict: 'fresh',
      storedTreeStamp: stored,
      currentTreeStamp: current,
    });
    expect(result?.reason).toMatch(/remains fresh across HEAD movement/);
  });

  it('reports stale when the declared path content changed across HEADs', () => {
    const changedCurrent = {
      repositoryRoot: '/repo',
      headSha: 'b'.repeat(40),
      contentIdentity: [
        { path: 'src/fix.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: 'd'.repeat(40) },
      ],
    };

    const result = completionFreshnessForEvidence(
      { treeStamp: stored },
      { currentStamp: () => changedCurrent },
    );

    expect(result).toMatchObject({
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: changedCurrent,
    });
    expect(result?.reason).toMatch(/Committed content for src\/fix\.ts changed/);
  });

  it('reports stale when the declared path set changes', () => {
    const changedCurrent = {
      repositoryRoot: '/repo',
      headSha: 'b'.repeat(40),
      contentIdentity: [
        { path: 'src/other.ts', workingTreeBlobSha: 'c'.repeat(40), headBlobSha: 'c'.repeat(40) },
      ],
    };

    const result = completionFreshnessForEvidence(
      { treeStamp: stored },
      { currentStamp: () => changedCurrent },
    );

    expect(result?.verdict).toBe('stale');
    expect(result?.reason).toMatch(/different declared path set/);
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

  it('fails closed when a legacy stamp has no committed-content identity', () => {
    const result = completionFreshnessForEvidence(
      { treeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) } },
      { currentStamp: () => stored },
    );

    expect(result?.verdict).toBe('not-applicable');
    expect(result?.reason).toMatch(/No changed files.*not applicable/);
  });

  it('reports pathless verification as not-applicable for explicit and legacy-empty path lists', () => {
    for (const evidence of [
      { filesChanged: [], treeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) } },
      { treeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) } },
    ]) {
      const currentStamp = vi.fn(() => current);
      const result = completionFreshnessForEvidence(evidence, { currentStamp });

      expect(result).toMatchObject({
        verdict: 'not-applicable',
        storedTreeStamp: evidence.treeStamp,
      });
      expect(result?.reason).toMatch(/No changed files.*not applicable/);
      expect(currentStamp).not.toHaveBeenCalled();
    }
  });

  it('keeps a file-bearing stamp without content identity unavailable', () => {
    const result = completionFreshnessForEvidence(
      { filesChanged: ['src/fix.ts'], treeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) } },
      { currentStamp: () => current },
    );

    expect(result?.verdict).toBe('unavailable');
    expect(result?.reason).toMatch(/content identity/);
  });

  it('reports stale when a dirty worktree file exists but HEAD has no blob for it', () => {
    const result = completionFreshnessForEvidence(
      { treeStamp: stored },
      {
        currentStamp: () => ({
          repositoryRoot: '/repo',
          headSha: stored.headSha,
          contentIdentity: [{ path: 'src/fix.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: null }],
        }),
      },
    );

    expect(result?.verdict).toBe('stale');
    expect(result?.reason).toMatch(/does not match committed HEAD/);
  });

  /**
   * WI-42441 — `stale` is a claim about the EVIDENCE; `unavailable` is a claim about our
   * ABILITY TO CHECK. An unreadable submodule produces the same null headBlobSha as a real
   * drift, so this read path used to report a perfectly current completion as stale and
   * send the reader to re-verify it. The mismatch case above is the permanent CONTROL:
   * both tests assert on the same field, so an implementation that collapses the two
   * verdicts fails one of them whichever way it collapses.
   */
  it('reports unavailable, not stale, when a declared path could not be resolved', () => {
    const reason = "submodule 'libs/papercusp' could not be read at abc123456789";
    const result = completionFreshnessForEvidence(
      { treeStamp: stored },
      {
        currentStamp: () => ({
          repositoryRoot: '/repo',
          headSha: stored.headSha,
          contentIdentity: [
            {
              path: 'src/fix.ts',
              workingTreeBlobSha: 'c'.repeat(40),
              headBlobSha: null,
              headBlobUnresolvable: reason,
            },
          ],
        }),
      },
    );

    expect(result?.verdict).toBe('unavailable');
    expect(result?.reason).toContain(reason);
    expect(result?.reason).toMatch(/not evidence of staleness/);
  });
});

describe('completionTreeContentIdentityMatches — WI-1409142 absent-key hole', () => {
  /**
   * Stored evidence really can arrive with these keys MISSING rather than null: a
   * recursive `jsonb_strip_nulls` on the terminal payload write deleted them. Under
   * the old strict `!== null` such an entry read as a MATCH — `undefined !== null` is
   * true twice, then `undefined === undefined` — so the floor would mint `committed`
   * authority from an observation the server never actually made. That is the one
   * direction this check must never fail in.
   */
  it('does NOT report a match when both blob-sha keys are absent', () => {
    expect(completionTreeContentIdentityMatches([
      { path: 'src/fix.ts' } as unknown as CompletionTreeContentIdentity,
    ])).toBe(false);
  });

  it('does NOT report a match when only the HEAD side is absent', () => {
    expect(completionTreeContentIdentityMatches([
      { path: 'src/fix.ts', workingTreeBlobSha: 'c'.repeat(40) } as unknown as CompletionTreeContentIdentity,
    ])).toBe(false);
  });

  it('still matches when both sides carry the same observed sha', () => {
    expect(completionTreeContentIdentityMatches(identity)).toBe(true);
  });

  it('still rejects an explicit null, unchanged', () => {
    expect(completionTreeContentIdentityMatches([
      { path: 'src/fix.ts', workingTreeBlobSha: 'c'.repeat(40), headBlobSha: null },
    ])).toBe(false);
  });
});
