/**
 * P-207 (p2p-work-distribution-2026-07-02) unit tests: model-class routing.
 * The plan item IS the spec — "{frontier-remote | local-small | any} + latency
 * tolerance; bulk/background work routes to donated GPUs, frontier reasoning to
 * remote allotments; M12 foreign local slots DEFAULT 0 (fail closed)". Pure
 * module, no stubs needed (offer-budget.test.ts discipline).
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_CLASSES,
  decideModelClassRoute,
  evaluateRoutedClaimAuthority,
  parseModelClass,
  restrictEnvelopeToAxis,
  routeRefusalToReceiptFields,
} from './model-class-routing';
import type { BudgetEnvelope, WorkOffer } from './offer-budget';
import type { HostAvailability } from './claim-authority';

const remoteCap = { cap: 1_000, unit: 'usd-micros', maxPerCall: 100 } as const;
const localCap = { cap: 4, unit: 'slots', maxPerCall: 1 } as const;

const bothAxes: BudgetEnvelope = { remote: remoteCap, local: localCap };

function offer(over: Partial<WorkOffer> = {}): WorkOffer {
  return {
    offerId: 'offer-1',
    fleetSlug: 'fleet-a',
    publisherRef: 'device:origin-1',
    billedTo: 'pool:origin',
    modelClass: 'any',
    priority: 5,
    isolationReqs: [],
    budget: bothAxes,
    publishedAt: 1_000,
    ttlMs: 60_000,
    ...over,
  };
}

/** Host with capacity on both axes. */
const hostBoth: HostAvailability = {
  remote: { allotmentRemaining: 500, liveHeadroom: 800 },
  local: { allotmentRemaining: 2, liveHeadroom: 2 },
};

const measuredLocal = { localIndicativeLatencyMs: 1_500 };
const unknownLocal = { localIndicativeLatencyMs: null };

describe('parseModelClass (fail-closed vocabulary)', () => {
  it('accepts exactly the three-word vocabulary', () => {
    for (const c of MODEL_CLASSES) expect(parseModelClass(c)).toBe(c);
  });

  it('refuses unknown words, casing drift, and whitespace — never guesses', () => {
    for (const bad of ['frontier', 'LOCAL-SMALL', ' any', 'any ', 'standard', '']) {
      expect(parseModelClass(bad)).toBeNull();
    }
  });
});

describe('decideModelClassRoute', () => {
  it('unknown class is refused loudly (fail-closed), naming the vocabulary', () => {
    const d = decideModelClassRoute(offer({ modelClass: 'standard' }), measuredLocal);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.refusal.code).toBe('unknown_model_class');
    expect(d.refusal.detail).toContain('frontier-remote');
  });

  it('frontier-remote routes remote only, regardless of latency tolerance', () => {
    const d = decideModelClassRoute(offer({ modelClass: 'frontier-remote', latencyToleranceMs: 10 }), unknownLocal);
    expect(d.ok && d.axes).toEqual(['remote']);
  });

  it('frontier-remote without a remote envelope axis is a budget mismatch (no unmetered inference)', () => {
    const d = decideModelClassRoute(
      offer({ modelClass: 'frontier-remote', budget: { remote: null, local: localCap } }),
      measuredLocal,
    );
    expect(!d.ok && d.refusal.code).toBe('model_class_budget_mismatch');
  });

  it('local-small routes local only; latency never gates an explicit local choice', () => {
    const d = decideModelClassRoute(
      offer({ modelClass: 'local-small', latencyToleranceMs: 1 }), // far below indicative
      measuredLocal,
    );
    expect(d.ok && d.axes).toEqual(['local']);
  });

  it('local-small without a local envelope axis is a budget mismatch', () => {
    const d = decideModelClassRoute(
      offer({ modelClass: 'local-small', budget: { remote: remoteCap, local: null } }),
      measuredLocal,
    );
    expect(!d.ok && d.refusal.code).toBe('model_class_budget_mismatch');
  });

  describe("'any' — bulk to donated GPUs, frontier to remote", () => {
    it('no tolerance stated ⇒ latency-tolerant bulk ⇒ local PREFERRED, remote fallback', () => {
      const d = decideModelClassRoute(offer(), measuredLocal);
      expect(d.ok && d.axes).toEqual(['local', 'remote']);
    });

    it('tolerance within measured local latency keeps local first', () => {
      const d = decideModelClassRoute(offer({ latencyToleranceMs: 2_000 }), measuredLocal);
      expect(d.ok && d.axes).toEqual(['local', 'remote']);
    });

    it('tolerance below measured local latency excludes local (remote only)', () => {
      const d = decideModelClassRoute(offer({ latencyToleranceMs: 500 }), measuredLocal);
      expect(d.ok && d.axes).toEqual(['remote']);
    });

    it('UNKNOWN local latency cannot satisfy a stated bound — local excluded (fail-closed)', () => {
      const d = decideModelClassRoute(offer({ latencyToleranceMs: 60_000 }), unknownLocal);
      expect(d.ok && d.axes).toEqual(['remote']);
    });

    it('local-only envelope + tolerance the host cannot meet refuses latency_excludes_all_axes', () => {
      const d = decideModelClassRoute(
        offer({ budget: { remote: null, local: localCap }, latencyToleranceMs: 500 }),
        measuredLocal,
      );
      expect(!d.ok && d.refusal.code).toBe('latency_excludes_all_axes');
      if (d.ok) return;
      expect(d.refusal.detail).toContain('1500ms');
    });

    it('malformed tolerance (negative/NaN) fails closed off the local axis', () => {
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const d = decideModelClassRoute(offer({ latencyToleranceMs: bad }), measuredLocal);
        expect(d.ok && d.axes).toEqual(['remote']);
      }
    });

    it('empty envelope is the free-task pass-through: ok with no axes', () => {
      const d = decideModelClassRoute(offer({ budget: { remote: null, local: null } }), measuredLocal);
      expect(d.ok && d.axes).toEqual([]);
    });
  });
});

describe('restrictEnvelopeToAxis', () => {
  it('keeps exactly the routed axis, nulls the other', () => {
    expect(restrictEnvelopeToAxis(bothAxes, 'local')).toEqual({ remote: null, local: localCap });
    expect(restrictEnvelopeToAxis(bothAxes, 'remote')).toEqual({ remote: remoteCap, local: null });
  });
});

describe('evaluateRoutedClaimAuthority (P-207 × P-202 composition)', () => {
  it("'any' with local capacity lands on the donated GPU: local axis, local grants ONLY", () => {
    const r = evaluateRoutedClaimAuthority(offer(), hostBoth, measuredLocal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.axis).toBe('local');
    expect(r.grants.map((g) => g.axis)).toEqual(['local']);
    // Grant is the D-007 two-layer min, seeded from the LOCAL envelope entry.
    expect(r.grants[0]!.effectiveCap.unit).toBe('slots');
    expect(r.grants[0]!.effectiveCap.cap).toBe(2); // min(offer 4, min(allot 2, headroom 2))
  });

  it("'any' falls back to remote when the local axis has zero headroom (M12 fail-closed default)", () => {
    const m12Host: HostAvailability = {
      remote: { allotmentRemaining: 500, liveHeadroom: 800 },
      local: { allotmentRemaining: 2, liveHeadroom: 0 }, // deltas not landed ⇒ 0
    };
    const r = evaluateRoutedClaimAuthority(offer(), m12Host, measuredLocal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.axis).toBe('remote');
    expect(r.grants.map((g) => g.axis)).toEqual(['remote']);
  });

  it("'local-small' against a host serving no local axis refuses via the gate (axis_not_served)", () => {
    const r = evaluateRoutedClaimAuthority(
      offer({ modelClass: 'local-small' }),
      { remote: hostBoth.remote, local: null },
      measuredLocal,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.routeRefusal).toBeNull();
    if (r.routeRefusal !== null) return;
    expect(r.claimRefusals.map((f) => f.code)).toEqual(['axis_not_served']);
  });

  it('a route refusal short-circuits BEFORE the gate (unknown class)', () => {
    const r = evaluateRoutedClaimAuthority(offer({ modelClass: 'gpt-max' }), hostBoth, measuredLocal);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.routeRefusal?.code).toBe('unknown_model_class');
  });

  it('every admissible axis refused ⇒ ALL per-axis refusals returned for receipts', () => {
    const dryHost: HostAvailability = {
      remote: { allotmentRemaining: 0, liveHeadroom: 800 },
      local: { allotmentRemaining: 2, liveHeadroom: 0 },
    };
    const r = evaluateRoutedClaimAuthority(offer(), dryHost, measuredLocal);
    expect(r.ok).toBe(false);
    if (r.ok || r.routeRefusal !== null) return;
    expect(r.claimRefusals.map((f) => f.code).sort()).toEqual(['no_allotment_remaining', 'no_live_headroom']);
  });

  it('free unmetered task (empty envelope, any) is claimable with no axis and no grants', () => {
    const r = evaluateRoutedClaimAuthority(
      offer({ budget: { remote: null, local: null } }),
      hostBoth,
      measuredLocal,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.axis).toBeNull();
    expect(r.grants).toEqual([]);
  });
});

describe('routeRefusalToReceiptFields', () => {
  it('maps to the work-offer:claim refusal shape (class-level: no budgetAxis)', () => {
    const fields = routeRefusalToReceiptFields({ code: 'unknown_model_class', detail: 'x' });
    expect(fields).toEqual({
      action: 'work-offer:claim',
      refusal: { code: 'unknown_model_class', detail: 'x' },
    });
  });
});
