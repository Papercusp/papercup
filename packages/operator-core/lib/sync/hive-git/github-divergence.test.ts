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
