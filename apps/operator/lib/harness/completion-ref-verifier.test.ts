import { describe, expect, it } from 'vitest';
import {
  decideVerificationOutcome,
  defaultRunGitLsRemote,
  parseLsRemoteOutput,
  verifyHarnessFeatures,
  type GitLsRemoteResult,
  type RunGitLsRemote,
} from './completion-ref-verifier';

describe('parseLsRemoteOutput', () => {
  const sha = 'a'.repeat(40);

  it('returns "found" when output line starts with the sha', () => {
    const stdout = `${sha}\trefs/heads/main\n`;
    expect(parseLsRemoteOutput(stdout, sha)).toEqual({ kind: 'found', sha });
  });

  it('returns "not_found" on empty output', () => {
    expect(parseLsRemoteOutput('', sha)).toEqual({ kind: 'not_found' });
  });

  it('returns "not_found" when output is whitespace only', () => {
    expect(parseLsRemoteOutput('   \n\n  ', sha)).toEqual({ kind: 'not_found' });
  });

  it('matches across multi-line output (sha appears for >1 ref)', () => {
    const stdout = `${sha}\trefs/heads/main\n${sha}\trefs/tags/v1\n`;
    expect(parseLsRemoteOutput(stdout, sha)).toEqual({ kind: 'found', sha });
  });

  it('returns "not_found" when the line starts with a different sha', () => {
    const otherSha = 'b'.repeat(40);
    const stdout = `${otherSha}\trefs/heads/main\n`;
    expect(parseLsRemoteOutput(stdout, sha)).toEqual({ kind: 'not_found' });
  });

  it('tolerates leading whitespace on the line (trim before matching)', () => {
    const stdout = `   ${sha}\trefs/heads/main\n`;
    expect(parseLsRemoteOutput(stdout, sha)).toEqual({ kind: 'found', sha });
  });
});

describe('decideVerificationOutcome', () => {
  it('"found" maps to "verified"', () => {
    expect(decideVerificationOutcome({ kind: 'found', sha: 'abc' })).toBe('verified');
  });

  it('"not_found" maps to "divergent"', () => {
    expect(decideVerificationOutcome({ kind: 'not_found' })).toBe('divergent');
  });

  it('"error" maps to "error" (network errors do NOT poison the row)', () => {
    // Load-bearing: a transient network outage must not flip a feature
    // to divergent. P-016c contract.
    expect(decideVerificationOutcome({ kind: 'error', reason: 'ETIMEDOUT' })).toBe(
      'error',
    );
  });

  it('all GitLsRemoteResult variants are exhaustively mapped', () => {
    // Sentinel: if a new variant gets added to GitLsRemoteResult, this
    // test should fail to compile (TypeScript exhaustiveness). The
    // explicit list here makes the breakage obvious in code review.
    const variants: GitLsRemoteResult[] = [
      { kind: 'found', sha: 'x' },
      { kind: 'not_found' },
      { kind: 'error', reason: 'y' },
    ];
    const outcomes = variants.map(decideVerificationOutcome);
    expect(outcomes).toEqual(['verified', 'divergent', 'error']);
  });
});

describe('defaultRunGitLsRemote', () => {
  it('returns "error" cleanly when the remote URL is unreachable (no host)', async () => {
    // Use a deliberately-invalid URL so git fails fast (DNS or auth).
    // Tight timeout keeps the test short — git ls-remote against a
    // bad URL typically errors within 2-3s.
    const result = await defaultRunGitLsRemote(
      'https://definitely-not-a-real-host-2026-05-24.invalid/no/repo.git',
      'a'.repeat(40),
      { timeoutMs: 5_000 },
    );
    expect(result.kind).toBe('error');
  }, 10_000);
});

describe('verifyHarnessFeatures — dep injection contract', () => {
  // Without a real PG to drive, we can only verify the dep-injection
  // contract: a stubbed runGitLsRemote IS what the function calls.
  // Full integration coverage (PG row updates, divergence write,
  // network-error no-poison) sits with the live verifier script
  // (apps/operator/scripts/run-dogfood-bootstrap.ts is the pattern).
  //
  // The test below short-circuits before any PG access by stubbing
  // the runner — but selectVerifiableFeatures still touches PG, so
  // we expect a thrown PG error rather than a graceful return. The
  // assertion is just "the function tried to read PG"; the stub
  // proves we got far enough.
  it('throws when PG is unavailable (read happens before any git call)', async () => {
    let runnerCalled = false;
    const stubRunner: RunGitLsRemote = async () => {
      runnerCalled = true;
      return { kind: 'not_found' };
    };
    // Simulate PG unavailable via the injectable accessor. (Don't rely on a
    // real connection — the dev box has live PG — nor on getOrgPg crashing,
    // which it no longer does.) The feature read happens before any git call,
    // so this must reject BEFORE the runner is invoked.
    const throwingGetPg = (): never => {
      throw new Error('PG unavailable');
    };
    await expect(
      verifyHarnessFeatures('does-not-exist-slug', {
        runGitLsRemote: stubRunner,
        getPg: throwingGetPg,
      }),
    ).rejects.toThrow(/PG unavailable/);
    expect(runnerCalled).toBe(false); // proves the PG read precedes any git call
  }, 5_000);
});
