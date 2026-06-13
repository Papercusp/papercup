/**
 * Unit tests for the decision-ledger DISPOSITION layer
 * (queen-autonomy-policy-2026-06-13 B-13 / P-111). `buildDispositionRow` +
 * `dispositionPosture` are PURE — no PG, no flag — so they're tested directly. The
 * flag-gate + INSERT are integration concerns exercised via recordDecisionDisposition.
 */

import { describe, expect, it } from 'vitest';
import { buildDispositionRow, dispositionPosture, DISPOSITIONS } from './disposition';
import type { AutonomyDecision } from '../autonomy/decider';

function decision(over: Partial<AutonomyDecision> = {}): AutonomyDecision {
  return {
    posture: 'gated',
    category: 'plan-governance',
    action: 'plans:set-status',
    riskTier: 'moderate',
    authority: 'system',
    reversibility: 'reversible',
    effectiveCeiling: 'never-auto',
    protected: false,
    armed: false,
    wouldAutoIfArmed: false,
    reasons: ['policy-not-armed'],
    ...over,
  };
}

describe('dispositionPosture — gate→ledger posture mapping', () => {
  it('an auto decision is always posture auto, whatever the disposition', () => {
    const d = decision({ posture: 'auto', armed: true, wouldAutoIfArmed: true, reasons: [] });
    for (const disp of DISPOSITIONS) expect(dispositionPosture(d, disp)).toBe('auto');
  });

  it('acting on a GATED decision = proposed (proposed for owner ratification)', () => {
    expect(dispositionPosture(decision({ posture: 'gated' }), 'act')).toBe('proposed');
  });

  it('any non-act disposition on a gated decision stays gated (owner Queue owns it)', () => {
    for (const disp of ['defer', 'reject', 'route-to-research', 'no-op'] as const) {
      expect(dispositionPosture(decision({ posture: 'gated' }), disp)).toBe('gated');
    }
  });
});

describe('buildDispositionRow — field mapping', () => {
  it('maps the decision axes onto the disposition row + sets layer-appropriate posture', () => {
    const row = buildDispositionRow({
      workspaceId: 'default',
      harnessSlug: 'papercup',
      decision: decision({ posture: 'auto', armed: true, wouldAutoIfArmed: true, reasons: [] }),
      disposition: 'act',
      links: { actionLedgerId: 99, itemRef: 'WI-7' },
    });
    expect(row.category).toBe('plan-governance');
    expect(row.action).toBe('plans:set-status');
    expect(row.riskTier).toBe('moderate');
    expect(row.reversibility).toBe('reversible');
    expect(row.authority).toBe('system');
    expect(row.disposition).toBe('act');
    expect(row.posture).toBe('auto');
    expect(row.links).toMatchObject({ actionLedgerId: 99, itemRef: 'WI-7' });
  });

  it('defaults why to the decision reasons joined; an explicit why wins', () => {
    const auto = buildDispositionRow({
      workspaceId: 'default',
      decision: decision({ reasons: ['owner-authority', 'irreversible-action'] }),
      disposition: 'reject',
    });
    expect(auto.why).toBe('owner-authority; irreversible-action');

    const explicit = buildDispositionRow({
      workspaceId: 'default',
      decision: decision({ reasons: ['policy-not-armed'] }),
      disposition: 'reject',
      why: 'duplicate of WI-3',
    });
    expect(explicit.why).toBe('duplicate of WI-3');
  });

  it('carries revisit_at ONLY for a defer; drops it for other dispositions', () => {
    const when = '2026-07-01T00:00:00.000Z';
    expect(
      buildDispositionRow({ workspaceId: 'd', decision: decision(), disposition: 'defer', revisitAt: when }).revisitAt,
    ).toBe(when);
    // a revisitAt passed on a non-defer is ignored (no column meaning).
    expect(
      buildDispositionRow({ workspaceId: 'd', decision: decision(), disposition: 'no-op', revisitAt: when }).revisitAt,
    ).toBeNull();
  });

  it('accepts a Date for revisitAt and ISO-encodes it', () => {
    const row = buildDispositionRow({
      workspaceId: 'd',
      decision: decision(),
      disposition: 'defer',
      revisitAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(row.revisitAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('stows the full decision context in metadata (wouldAutoIfArmed, armed, ceiling, protected, signals)', () => {
    const row = buildDispositionRow({
      workspaceId: 'd',
      decision: decision({
        wouldAutoIfArmed: true,
        armed: false,
        effectiveCeiling: 'moderate',
        protected: false,
        signals: { calibrationWeight: 0.8 },
        graduationEvidence: { calibrationWeight: 0.8 },
      }),
      disposition: 'defer',
    });
    expect(row.metadata).toMatchObject({
      wouldAutoIfArmed: true,
      armed: false,
      effectiveCeiling: 'moderate',
      protected: false,
      signals: { calibrationWeight: 0.8 },
      graduationEvidence: { calibrationWeight: 0.8 },
    });
  });

  it('the P-111 worked example: "plan needs more research" → plan-governance route-to-research + linked research task', () => {
    const row = buildDispositionRow({
      workspaceId: 'default',
      harnessSlug: 'papercup',
      decision: decision({ category: 'plan-governance', action: 'plans:add-item' }),
      disposition: 'route-to-research',
      why: 'plan needs more research before it can be placed',
      links: { itemRef: 'plan:foo#P-007', researchTaskId: 'WI-42' },
    });
    expect(row.category).toBe('plan-governance');
    expect(row.disposition).toBe('route-to-research');
    expect(row.posture).toBe('gated'); // gated decision, non-act disposition
    expect(row.why).toBe('plan needs more research before it can be placed');
    expect(row.links).toMatchObject({ itemRef: 'plan:foo#P-007', researchTaskId: 'WI-42' });
  });

  it('links is null when no links given', () => {
    const row = buildDispositionRow({ workspaceId: 'd', decision: decision(), disposition: 'no-op' });
    expect(row.links).toBeNull();
  });

  it('a null category (unmapped action, fail-safe) is preserved', () => {
    const row = buildDispositionRow({
      workspaceId: 'd',
      decision: decision({ category: null, reasons: ['unmapped-category'] }),
      disposition: 'reject',
    });
    expect(row.category).toBeNull();
    expect(row.why).toBe('unmapped-category');
  });

  it('honors an explicit posture override (the P-112 back-fill posture=auto on a gated decision)', () => {
    const row = buildDispositionRow({
      workspaceId: 'd',
      decision: decision({ posture: 'gated', category: 'spend-budget', wouldAutoIfArmed: false }),
      disposition: 'act',
      posture: 'auto',
    });
    // without the override, dispositionPosture(gated, act) would be 'proposed'.
    expect(row.posture).toBe('auto');
    // the honest gate view still rides metadata.
    expect(row.metadata.wouldAutoIfArmed).toBe(false);
  });

  it('merges extraMetadata into the row metadata (decision-specific facts: score/tier)', () => {
    const row = buildDispositionRow({
      workspaceId: 'd',
      decision: decision(),
      disposition: 'act',
      extraMetadata: { gymScore: 0.82, modelTier: 'sonnet' },
    });
    expect(row.metadata).toMatchObject({ gymScore: 0.82, modelTier: 'sonnet' });
    // the decision context is still present alongside the extra facts.
    expect(row.metadata).toHaveProperty('wouldAutoIfArmed');
  });
});
