/**
 * decider.test.ts — the Queen autonomy decider gate (B-12 / P-070, P-071).
 *
 * The cross-module recursion-safety invariants (protected can't graduate,
 * irreversible/owner/unmapped never auto, behavior-neutral migration) are pinned
 * against the LIVE decider in
 * `harness/improvements/recursion-safety-invariants.test.ts` (P-090/P-091, which
 * repoints its `autoAllowed` at `decideAutonomy`). THIS suite pins the decider's
 * OWN surface: the disposition record shape, the arming gate, the unmapped/null
 * branches, the `wouldAutoIfArmed` shadow signal, the P-071 signal routing, the
 * rank-breakdown signal extraction, and the async resolver's dep wiring.
 */

import { describe, it, expect } from 'vitest';
import { RISK_TIERS, AUTONOMY_CEILINGS, type AutonomyCeiling, type RiskTier } from '@papercusp/plan-parser';
import { defaultPolicyFor } from './policy';
import {
  decideAutonomy,
  resolveAutonomyDecision,
  decideRankedItem,
  graduationEvidenceSignals,
  extractEconomicSignals,
  type DeciderDeps,
} from './decider';

describe('decideAutonomy — the D-004 gate', () => {
  it('BEHAVIOR-NEUTRAL: unarmed, EVERY input gates (auto is impossible until P-092)', () => {
    let sweep = 0;
    for (const riskTier of [...RISK_TIERS, null] as (RiskTier | null)[]) {
      for (const ceiling of [...AUTONOMY_CEILINGS, null] as (AutonomyCeiling | null)[]) {
        for (const authority of ['system', 'owner'] as const) {
          for (const reversibility of ['reversible', 'irreversible', 'unknown'] as const) {
            const d = decideAutonomy({
              category: 'knowledge-curation',
              riskTier,
              authority,
              reversibility,
              effectiveCeiling: ceiling,
              armed: false,
            });
            expect(d.posture).toBe('gated');
            sweep++;
          }
        }
      }
    }
    expect(sweep).toBe(6 * 7 * 2 * 3);
  });

  it('armed + reversible + system + risk ≤ ceiling in a non-protected category ⇒ auto', () => {
    const d = decideAutonomy({
      category: 'knowledge-curation',
      riskTier: 'low',
      authority: 'system',
      reversibility: 'reversible',
      effectiveCeiling: 'moderate',
      armed: true,
    });
    expect(d.posture).toBe('auto');
    expect(d.wouldAutoIfArmed).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  it('risk above the effective ceiling ⇒ gated (risk-above-ceiling)', () => {
    const d = decideAutonomy({
      category: 'knowledge-curation',
      riskTier: 'high',
      authority: 'system',
      reversibility: 'reversible',
      effectiveCeiling: 'low',
      armed: true,
    });
    expect(d.posture).toBe('gated');
    expect(d.reasons).toContain('risk-above-ceiling');
  });

  it('a never-auto ceiling (e.g. a locked/protected category) ⇒ gated (ceiling-never-auto)', () => {
    const d = decideAutonomy({
      category: 'release-deploy',
      riskTier: 'trivial',
      authority: 'system',
      reversibility: 'reversible',
      effectiveCeiling: 'never-auto',
      armed: true,
    });
    expect(d.posture).toBe('gated');
    expect(d.reasons).toContain('ceiling-never-auto');
  });

  it('authority=owner gates even at trivial risk under a permissive ceiling', () => {
    const d = decideAutonomy({
      category: 'knowledge-curation',
      riskTier: 'trivial',
      authority: 'owner',
      reversibility: 'reversible',
      effectiveCeiling: 'critical',
      armed: true,
    });
    expect(d.posture).toBe('gated');
    expect(d.reasons).toContain('owner-authority');
  });

  it('irreversible (and unknown→irreversible) gates even when the risk half would permit it', () => {
    for (const reversibility of ['irreversible', 'unknown'] as const) {
      const d = decideAutonomy({
        category: 'knowledge-curation',
        riskTier: 'trivial',
        authority: 'system',
        reversibility,
        effectiveCeiling: 'critical',
        armed: true,
      });
      expect(d.posture).toBe('gated');
      expect(d.reasons).toContain('irreversible-action');
    }
    // missing reversibility ⇒ fail-safe irreversible
    const d = decideAutonomy({
      category: 'knowledge-curation',
      riskTier: 'trivial',
      authority: 'system',
      effectiveCeiling: 'critical',
      armed: true,
    });
    expect(d.reversibility).toBe('irreversible');
    expect(d.posture).toBe('gated');
  });

  it('an unmapped category (null) gates with unmapped-category, never auto (D-009 fail-safe)', () => {
    const d = decideAutonomy({
      category: null,
      riskTier: 'trivial',
      authority: 'system',
      reversibility: 'reversible',
      effectiveCeiling: 'critical',
      armed: true,
    });
    expect(d.posture).toBe('gated');
    expect(d.category).toBeNull();
    expect(d.reasons).toContain('unmapped-category');
  });

  it('an unknown action string resolves to a null category and gates', () => {
    const d = decideAutonomy({ action: 'totally:unknown', riskTier: 'trivial', reversibility: 'reversible', effectiveCeiling: 'critical', armed: true });
    expect(d.category).toBeNull();
    expect(d.posture).toBe('gated');
  });

  it('derives the category from a known action (deploy:harness → release-deploy)', () => {
    const d = decideAutonomy({ action: 'deploy:harness', riskTier: 'trivial', reversibility: 'reversible', effectiveCeiling: 'critical', armed: true });
    expect(d.category).toBe('release-deploy');
    expect(d.protected).toBe(true);
  });

  it('wouldAutoIfArmed reports the substantive verdict even while unarmed (the shadow signal)', () => {
    const wouldAuto = decideAutonomy({
      category: 'knowledge-curation',
      riskTier: 'low',
      authority: 'system',
      reversibility: 'reversible',
      effectiveCeiling: 'moderate',
      armed: false,
    });
    expect(wouldAuto.posture).toBe('gated');
    expect(wouldAuto.wouldAutoIfArmed).toBe(true);
    expect(wouldAuto.reasons).toEqual(['policy-not-armed']);

    const wouldGate = decideAutonomy({
      category: 'knowledge-curation',
      riskTier: 'critical',
      authority: 'system',
      reversibility: 'reversible',
      effectiveCeiling: 'low',
      armed: false,
    });
    expect(wouldGate.wouldAutoIfArmed).toBe(false);
    // when it would gate anyway, the substantive reason is recorded (not 'policy-not-armed')
    expect(wouldGate.reasons).toContain('risk-above-ceiling');
    expect(wouldGate.reasons).not.toContain('policy-not-armed');
  });

  it('records protection informationally without it being a gate (an UNLOCKED protected category can auto within its ceiling — D-005)', () => {
    // release-deploy is protected, but once the owner UNLOCKS it (effective ceiling
    // > never-auto) the gate must let it auto within the ceiling — protection is the
    // lock, not a separate hard gate.
    const d = decideAutonomy({
      category: 'release-deploy',
      riskTier: 'low',
      authority: 'system',
      reversibility: 'reversible',
      effectiveCeiling: 'moderate', // owner unlocked + set a ceiling
      armed: true,
    });
    expect(d.protected).toBe(true);
    expect(d.posture).toBe('auto');
  });
});

describe('P-071 — economic signal routing (calibration/deferral → evidence; owner-preference re-rank only)', () => {
  it('graduationEvidenceSignals keeps calibration + deferral, DROPS owner-preference', () => {
    expect(
      graduationEvidenceSignals({ calibrationWeight: 0.8, deferralInterest: 3, ownerPreference: 5 }),
    ).toEqual({ calibrationWeight: 0.8, deferralInterest: 3 });
    expect(graduationEvidenceSignals(undefined)).toEqual({});
    expect(graduationEvidenceSignals({ ownerPreference: 9 })).toEqual({});
  });

  it('a decision echoes its signals and exposes the evidence subset', () => {
    const d = decideAutonomy({
      category: 'ideation-intake',
      riskTier: 'low',
      reversibility: 'reversible',
      effectiveCeiling: 'moderate',
      armed: true,
      signals: { calibrationWeight: 0.9, deferralInterest: 2, ownerPreference: 4 },
    });
    expect(d.signals).toEqual({ calibrationWeight: 0.9, deferralInterest: 2, ownerPreference: 4 });
    expect(d.graduationEvidence).toEqual({ calibrationWeight: 0.9, deferralInterest: 2 });
  });

  it('extractEconomicSignals pulls the three named features out of a rank breakdown', () => {
    const ranked = {
      id: 'x',
      rank: {
        score: 10,
        features: [
          { feature: 'calibration', value: 0.7 },
          { feature: 'deferral-interest', value: 2.5 },
          { feature: 'owner-preference', value: 1.2 },
          { feature: 'blocking-impact', value: 4 },
        ],
      },
    };
    expect(extractEconomicSignals(ranked)).toEqual({
      calibrationWeight: 0.7,
      deferralInterest: 2.5,
      ownerPreference: 1.2,
    });
  });

  it('extractEconomicSignals returns undefined when there is no rank breakdown', () => {
    expect(extractEconomicSignals({})).toBeUndefined();
    expect(extractEconomicSignals({ rank: { features: [{ feature: 'staleness', value: 1 }] } })).toBeUndefined();
  });
});

describe('resolveAutonomyDecision — the async resolver wires the policy store + arming flag', () => {
  const deps = (over: Partial<DeciderDeps> = {}): DeciderDeps => ({
    getPolicy: async (category) => defaultPolicyFor(category),
    isArmed: async () => false,
    ...over,
  });

  it('unarmed ⇒ gated regardless of policy', async () => {
    const d = await resolveAutonomyDecision(
      { action: 'memory:remember', riskTier: 'trivial', reversibility: 'reversible' },
      deps({ isArmed: async () => false }),
    );
    expect(d.posture).toBe('gated');
    expect(d.category).toBe('knowledge-curation');
  });

  it('armed but the category ships never-auto (default) ⇒ still gated', async () => {
    const d = await resolveAutonomyDecision(
      { action: 'memory:remember', riskTier: 'trivial', reversibility: 'reversible' },
      deps({ isArmed: async () => true }),
    );
    expect(d.posture).toBe('gated');
    expect(d.effectiveCeiling).toBe('never-auto');
    expect(d.reasons).toContain('ceiling-never-auto');
  });

  it('armed + an owner-lowered ceiling ⇒ auto within the cap', async () => {
    const d = await resolveAutonomyDecision(
      { action: 'memory:remember', riskTier: 'low', reversibility: 'reversible' },
      deps({
        isArmed: async () => true,
        getPolicy: async (category) => ({
          ...defaultPolicyFor(category),
          locked: false,
          ceiling: 'moderate',
          graduatedLevel: 'moderate',
        }),
      }),
    );
    expect(d.posture).toBe('auto');
    expect(d.effectiveCeiling).toBe('moderate');
  });

  it('a null category skips the policy read and gates (fail-safe)', async () => {
    let read = false;
    const d = await resolveAutonomyDecision(
      { action: 'search:fulltext', riskTier: 'trivial', reversibility: 'reversible' },
      deps({ isArmed: async () => true, getPolicy: async (c) => { read = true; return defaultPolicyFor(c); } }),
    );
    expect(d.category).toBeNull();
    expect(d.posture).toBe('gated');
    expect(read).toBe(false);
  });
});

describe('decideRankedItem — the EX P-013 seam (decider reads the ranked frontier)', () => {
  const deps: DeciderDeps = {
    getPolicy: async (category) => ({
      ...defaultPolicyFor(category),
      locked: false,
      ceiling: 'high',
      graduatedLevel: 'high',
    }),
    isArmed: async () => true,
  };

  it('reads a ranked frontier row’s economic signals (P-071) and folds them into the decision', async () => {
    const rankedRow = {
      id: 'WI-1',
      rank: {
        score: 9,
        features: [
          { feature: 'calibration', value: 0.6 },
          { feature: 'deferral-interest', value: 2 },
          { feature: 'owner-preference', value: 3 },
        ],
      },
    };
    const d = await decideRankedItem(
      rankedRow,
      { action: 'memory:remember', riskTier: 'low', reversibility: 'reversible' },
      deps,
    );
    expect(d.posture).toBe('auto');
    expect(d.signals).toEqual({ calibrationWeight: 0.6, deferralInterest: 2, ownerPreference: 3 });
    // P-071 routing: owner-preference is re-rank only, never graduation evidence.
    expect(d.graduationEvidence).toEqual({ calibrationWeight: 0.6, deferralInterest: 2 });
  });

  it('explicit baseInput.signals win over the extracted ones', async () => {
    const rankedRow = { id: 'x', rank: { score: 1, features: [{ feature: 'calibration', value: 0.1 }] } };
    const d = await decideRankedItem(
      rankedRow,
      { action: 'memory:remember', riskTier: 'low', reversibility: 'reversible', signals: { calibrationWeight: 0.99 } },
      deps,
    );
    expect(d.signals).toEqual({ calibrationWeight: 0.99 });
  });
});
