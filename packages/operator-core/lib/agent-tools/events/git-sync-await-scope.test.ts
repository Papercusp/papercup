/**
 * EI-24719187042784648 — the ONE scoping rule both git-sync await doors share, checked
 * against the REAL payload matcher the await engine applies at fire time. The await-tool
 * tests only prove which filter is registered; this proves that filter does what it claims
 * on payloads shaped exactly as git-sync-events.ts emits them.
 */
import { describe, expect, it } from 'vitest';
import { payloadMatchesFilter } from '../../events/await/pattern';
import {
  gitSyncAwaitScope,
  gitSyncInstallGlobalKind,
  gitSyncScopePayloadFilter,
  gitSyncShaSuffixProblem,
  isFullGitObjectId,
} from './git-sync-await-scope';

const SHA = 'c'.repeat(40);
const SCOPE = { installSlug: 'papercusp', workspaceId: 'papercusp-workspace' };

/** Payload shapes copied from emitGitSyncCommittedEvent / emitGitSyncEgressedEvent. */
const committed = (installSlug: string, committedAtMs: number) => ({
  sha: SHA,
  installSlug,
  workspaceId: 'papercusp-workspace',
  committedAtMs,
});
const egressed = (installSlug: string) => ({ sha: SHA, egressHead: SHA, installSlug, workspaceId: 'papercusp-workspace' });

describe('gitSyncScopePayloadFilter against the real payload matcher', () => {
  const commitFilter = gitSyncScopePayloadFilter(SCOPE, 'committed', 1_000);

  it('⭐ matches the caller install and rejects a submodule install (the measured 20:14Z false wake)', () => {
    expect(payloadMatchesFilter(commitFilter, committed('papercusp', 2_000))).toBe(true);
    expect(payloadMatchesFilter(commitFilter, committed('papercusp/libs/generic/search', 2_000))).toBe(false);
    expect(payloadMatchesFilter(commitFilter, committed('portal', 2_000))).toBe(false);
  });

  it('rejects a commit event produced before the wait registered', () => {
    expect(payloadMatchesFilter(commitFilter, committed('papercusp', 999))).toBe(false);
  });

  it('⭐ an egress filter still matches an egress payload, which has no committedAtMs (no silent hang)', () => {
    const egressFilter = gitSyncScopePayloadFilter(SCOPE, 'egressed', 1_000);
    expect(egressFilter).not.toHaveProperty('committedAtMs');
    expect(payloadMatchesFilter(egressFilter, egressed('papercusp'))).toBe(true);
    expect(payloadMatchesFilter(egressFilter, egressed('papercusp/libs/generic/search'))).toBe(false);
  });

  it('control: the same boundary applied to an egress payload WOULD never match', () => {
    // Pins why committedAtMs is restricted to commit filters.
    expect(payloadMatchesFilter(commitFilter, egressed('papercusp'))).toBe(false);
  });
});

describe('key classification', () => {
  it('identifies the install-global forms: the bare key and the sha glob', () => {
    expect(gitSyncInstallGlobalKind('git-sync:committed')).toBe('committed');
    expect(gitSyncInstallGlobalKind('git-sync:egressed')).toBe('egressed');
    expect(gitSyncInstallGlobalKind('git-sync:committed:*')).toBe('committed');
    expect(gitSyncInstallGlobalKind(`git-sync:committed:${SHA}`)).toBeNull();
    expect(gitSyncInstallGlobalKind('git-sync:lock-retry')).toBeNull();
  });

  it('flags a sha suffix git-sync can never emit, and accepts full SHA-1 / SHA-256 ids', () => {
    expect(gitSyncShaSuffixProblem(`git-sync:committed:${SHA}`)).toBeNull();
    expect(gitSyncShaSuffixProblem(`git-sync:egressed:${'d'.repeat(64)}`)).toBeNull();
    expect(gitSyncShaSuffixProblem('git-sync:committed:*')).toBeNull();
    expect(gitSyncShaSuffixProblem('git-sync:committed')).toBeNull();
    expect(gitSyncShaSuffixProblem('git-sync:committed:abc1234')).toMatchObject({ reason: 'short-sha' });
    expect(gitSyncShaSuffixProblem(`git-sync:committed:${SHA.toUpperCase()}`)).toMatchObject({ reason: 'short-sha' });
    expect(gitSyncShaSuffixProblem('git-sync:egressed:papercusp')).toMatchObject({ kind: 'egressed', reason: 'not-a-sha' });
    expect(isFullGitObjectId(SHA)).toBe(true);
    expect(isFullGitObjectId('abc1234')).toBe(false);
  });
});

describe('gitSyncAwaitScope', () => {
  it('resolves the concrete harness and workspace from ctx', () => {
    expect(gitSyncAwaitScope(null, { harnessSlug: 'papercusp', workspaceId: 'ws-a' } as never)).toEqual({
      installSlug: 'papercusp',
      workspaceId: 'ws-a',
    });
  });

  it('an explicit harness argument overrides the operator sentinel', () => {
    expect(gitSyncAwaitScope('portal', { harnessSlug: '*', workspaceId: 'ws-a' } as never)).toEqual({
      installSlug: 'portal',
      workspaceId: 'ws-a',
    });
  });

  it('returns null under operator scope with no harness, so callers refuse', () => {
    expect(gitSyncAwaitScope(null, { harnessSlug: '*', workspaceId: 'ws-a' } as never)).toBeNull();
    expect(gitSyncAwaitScope(undefined, { workspaceId: 'ws-a' } as never)).toBeNull();
  });
});
