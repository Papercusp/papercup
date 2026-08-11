/**
 * github-divergence (github-bridge-hive-egress P-006) — pure classification +
 * the escalation writer against an injected fake sql (unit-hermetic).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => {
    throw new Error('getOrgPg must not be reached — inject sql in tests');
  },
}));

import {
  collectDivergenceSignals,
  classifyDivergence,
  recordDivergenceVerdict,
  GITHUB_BRIDGE_ESCALATION_PHASE,
  GITHUB_BRIDGE_ESCALATION_KIND,
} from './github-divergence';

const egressNonFF = { remoteRef: 'refs/heads/staging', remoteSha: 'aaa', localSha: 'bbb', reason: 'diverged' };
const ingressNonFF = { branch: 'main', local: 'ccc', remote: 'ddd' };
const blockedAdmission = {
  head: 'eee',
  result: { admit: false, basis: 'blocked' as const, blockedAuthors: [{ githubUserId: 7, commits: ['eee'] }], errors: [] },
};
const secretBlock = { remoteRef: 'refs/heads/staging', findings: [{ kind: 'x' }] as never[], overflow: false, skippedLargeBlobs: 0 };

describe('collectDivergenceSignals — folds the mechanism residues', () => {
  it('collects all four signal classes', () => {
    const signals = collectDivergenceSignals({
      egress: { rejectedNonFF: [egressNonFF], blockedSecrets: [secretBlock] },
      ingress: { nonFF: [ingressNonFF] },
      admissions: [blockedAdmission],
    });
    expect(signals.map((s) => s.kind).sort()).toEqual([
      'admission-blocked',
      'egress-non-ff',
      'egress-secret-block',
      'ingress-non-ff',
    ]);
  });

  it('an unreachable remote is its own signal — NOT a clean pass (oddsmith 2026-07-19)', () => {
    const signals = collectDivergenceSignals({
      remoteUnreachable: {
        remoteUrl: 'https://github.com/aviynw/oddsmith.git',
        branches: ['staging'],
        errors: ['remote: Repository not found.'],
      },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('bridge-remote-unreachable');
    // The whole point: it must ESCALATE and need a human, because every
    // structured residue is empty exactly BECAUSE nothing was fetched.
    const verdict = classifyDivergence(signals);
    expect(verdict.action).toBe('escalate');
    expect(verdict.needsOwner).toBe(true);
    expect(verdict.detail).toMatch(/INERT/);
  });

  it('a TRANSIENT unreachable remote (spawn-level fault, EI-18152354175913564) escalates but does not need an owner', () => {
    const signals = collectDivergenceSignals({
      remoteUnreachable: {
        remoteUrl: 'https://github.com/acme/widgets.git',
        branches: ['main'],
        errors: ['Error: spawn git ENOENT'],
        transient: true,
      },
    });
    expect(signals[0]!.kind).toBe('bridge-remote-unreachable');
    const verdict = classifyDivergence(signals);
    expect(verdict.action).toBe('escalate');
    expect(verdict.needsOwner).toBe(false);
    expect(verdict.detail).not.toMatch(/fix the remote URL or wire the credential/i);
    expect(verdict.detail).toMatch(/transient/i);
  });

  it('an egress transport failure is not a clear pass (WI-37949)', () => {
    const signals = collectDivergenceSignals({
      egress: {
        rejectedNonFF: [],
        blockedSecrets: [],
        remoteErrors: [{ message: 'push refs/heads/staging: 403 email verification required', transient: false }],
      },
    });
    expect(signals).toEqual([
      {
        kind: 'bridge-egress-unreachable',
        errors: ['push refs/heads/staging: 403 email verification required'],
        transient: false,
      },
    ]);
    const verdict = classifyDivergence(signals);
    expect(verdict.action).toBe('escalate');
    expect(verdict.needsOwner).toBe(true);
    expect(verdict.detail).toMatch(/egress transport/i);
  });

  it('an egress spawn failure escalates without an owner lever', () => {
    const verdict = classifyDivergence(
      collectDivergenceSignals({
        egress: {
          rejectedNonFF: [],
          blockedSecrets: [],
          remoteErrors: [{ message: 'push refs/heads/staging: spawn git ENOENT', transient: true }],
        },
      }),
    );
    expect(verdict.action).toBe('escalate');
    expect(verdict.needsOwner).toBe(false);
    expect(verdict.detail).toMatch(/could not be SPAWNED/i);
  });

  it('admitted heads (baseline/clean) are non-events; empty/absent inputs yield no signals', () => {
    expect(
      collectDivergenceSignals({
        admissions: [
          { head: 'x', result: { admit: true, basis: 'baseline', blockedAuthors: [], errors: [] } },
          { head: 'y', result: { admit: true, basis: 'clean', blockedAuthors: [], errors: [] } },
        ],
      }),
    ).toEqual([]);
    expect(collectDivergenceSignals({})).toEqual([]);
    expect(collectDivergenceSignals({ egress: null, ingress: null })).toEqual([]);
  });

  it('a fail-closed admission error surfaces as basis error', () => {
    const s = collectDivergenceSignals({
      admissions: [{ head: 'z', result: { admit: false, basis: 'error', blockedAuthors: [], errors: ['pg down'] } }],
    });
    expect(s).toEqual([{ kind: 'admission-blocked', head: 'z', basis: 'error', blockedAuthors: [], errors: ['pg down'] }]);
  });

  // EI-18751829787526583: canonical EXISTS but is stale — the sibling gap to
  // egress-canonical-missing (a ref that is ABSENT). A green-reading 3h freeze
  // was caused by this case, not the absent one.
  it('a stale-but-present canonical ref is its own signal', () => {
    const s = collectDivergenceSignals({
      canonicalStale: { canonicalSha: 'c'.repeat(40), expectedSha: 'e'.repeat(40), behindCount: 21 },
    });
    expect(s).toEqual([
      { kind: 'egress-canonical-stale', canonicalSha: 'c'.repeat(40), expectedSha: 'e'.repeat(40), behindCount: 21 },
    ]);
  });
});

describe('classifyDivergence — policy', () => {
  it('no signals → clear', () => {
    const v = classifyDivergence([]);
    expect(v.action).toBe('clear');
    expect(v.needsOwner).toBe(false);
  });

  it('egress non-FF / secret block alone escalate WITHOUT the owner lever (integrator/scrub self-heal)', () => {
    const v = classifyDivergence(collectDivergenceSignals({ egress: { rejectedNonFF: [egressNonFF], blockedSecrets: [secretBlock] } }));
    expect(v.action).toBe('escalate');
    expect(v.needsOwner).toBe(false);
    expect(v.detail).toMatch(/NOT forced/);
    expect(v.detail).toMatch(/never force-pushed/);
  });

  it('ingress non-FF (history rewrite) and admission-blocked need the OWNER lever', () => {
    for (const signals of [
      collectDivergenceSignals({ ingress: { nonFF: [ingressNonFF] } }),
      collectDivergenceSignals({ admissions: [blockedAdmission] }),
    ]) {
      const v = classifyDivergence(signals);
      expect(v.action).toBe('escalate');
      expect(v.needsOwner).toBe(true);
    }
  });
});

describe('recordDivergenceVerdict — escalation writer (injected sql)', () => {
  const capture = () => {
    const calls: Array<{ q: string; params: unknown[] }> = [];
    const sql = { unsafe: async (q: string, params: unknown[]) => (calls.push({ q, params }), []) } as unknown as Sql;
    return { calls, sql };
  };

  it('escalate → upserts one row on the github-bridge phase with the divergence kind', async () => {
    const { calls, sql } = capture();
    const verdict = classifyDivergence(collectDivergenceSignals({ ingress: { nonFF: [ingressNonFF] } }));
    await recordDivergenceVerdict('shop-hive', 'ws', verdict, sql);
    expect(calls).toHaveLength(1);
    expect(calls[0].q).toMatch(/INSERT INTO harness_shared.harness_escalations/);
    const [slug, phase, body] = calls[0].params as [string, string, string];
    expect(slug).toBe('shop-hive');
    expect(phase).toBe(GITHUB_BRIDGE_ESCALATION_PHASE);
    const parsed = JSON.parse(body);
    expect(parsed.kind).toBe(GITHUB_BRIDGE_ESCALATION_KIND);
    expect(parsed.needs_owner).toBe(true);
    expect(parsed.signals).toHaveLength(1);
  });

  it('clear → clears ONLY its own kind (strict non-clobber, git-sync idiom)', async () => {
    const { calls, sql } = capture();
    await recordDivergenceVerdict('shop-hive', 'ws', classifyDivergence([]), sql);
    expect(calls).toHaveLength(1);
    expect(calls[0].q).toMatch(/SET escalation = NULL/);
    expect(calls[0].params).toContain(GITHUB_BRIDGE_ESCALATION_KIND);
  });

  it('never throws — a store failure is swallowed with a warn (best-effort, bridge tick must not die)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = { unsafe: async () => { throw new Error('pg down'); } } as unknown as Sql;
      await expect(
        recordDivergenceVerdict('shop-hive', 'ws', classifyDivergence(collectDivergenceSignals({ ingress: { nonFF: [ingressNonFF] } })), sql),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to record divergence verdict (shop-hive)'));
    } finally {
      warn.mockRestore();
    }
  });
});
