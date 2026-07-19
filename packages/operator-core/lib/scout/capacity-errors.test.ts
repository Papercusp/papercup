import { describe, it, expect } from 'vitest';
import {
  admissionDenialFrom,
  CAPACITY_CLASSIFIER_SCHEMA_VERSION,
  capacityContradictedFrom,
  capacityFallbacksFrom,
  isCapacityError,
  isLegacyCapacityError,
  isPersistedCapacityError,
} from './capacity-errors';

/**
 * capacity-errors is a one-function leaf module, but it is a LOAD-BEARING one: it decides
 * whether a scout failure counts against the "cycle error rate < 5%" release bar (quality-
 * metrics, the READ path) and whether it false-pages the Mug's error-streak alarm (scheduler,
 * the WRITE path). It had no test of its own — which is how a WRONG rationale sat in its doc
 * comment for a day (WI-4475).
 *
 * These tests pin the DECISION, not the implementation: an ADMISSION failure is NOT capacity.
 * The temptation to widen the match is real and recurring — WI-4475 proved timeouts ARE
 * capacity-induced, which makes "so classify them as capacity" look obviously correct. It is
 * not: WI-4541 (the gateway serializing the fleet through one admission slot while 9-10 of 12
 * sat idle) is an admission-path BUG that is indistinguishable, from the message alone, from a
 * genuinely walled pool. Excluding it as "capacity" would hide the defect from the one metric
 * that should catch it. If you are here to make these tests pass by widening isCapacityError,
 * read the module's doc comment first — the fix is a TYPED reason from the governor, not a
 * broader string match.
 */
describe('isCapacityError — the pool genuinely had nothing to give', () => {
  it('matches a governor-attested rate-limit-blocked denial', () => {
    expect(
      isCapacityError({
        admissionDenial: { reason: 'rate-limit-blocked', via: 'governor', pausedAccounts: 3, freeSlots: 0 },
      }),
    ).toBe(true);
  });

  it('matches an http-status-attested provider-429 denial', () => {
    expect(isCapacityError({ turn: { admissionDenial: { reason: 'provider-429', via: 'http-429' } } })).toBe(true);
  });

  it('recovers the typed denial — including the via/governorReason evidence — from an LlmCallError-shaped value', () => {
    // Dropping `via` on re-extraction would strip the attestation the classifier requires
    // every time a denial round-trips (the scheduler re-extracts before persisting).
    expect(
      admissionDenialFrom({
        turn: { admissionDenial: { reason: 'rate-limit-blocked', via: 'governor', governorReason: 'paused', freeSlots: 0 } },
      }),
    ).toEqual({
      reason: 'rate-limit-blocked',
      via: 'governor',
      governorReason: 'paused',
      freeSlots: 0,
    });
  });

  it('does not infer capacity from provider prose', () => {
    expect(isCapacityError('429 rate_limit_error: too many requests')).toBe(false);
  });
});

/**
 * WI-5435 ledger compatibility. `rate-limit-blocked` was spelled `all-accounts-paused` until
 * the rename, and quality-metrics re-classifies HISTORICAL ticks — rows written under the old
 * spelling are immutable and stay inside the release window for days after the rename ships.
 *
 * These tests exist because the failure mode is SILENT and points the wrong way: an
 * unrecognized reason yields `undefined`, a versioned row that classifies as not-capacity is
 * counted as a GENUINE error, and so dropping the normalization would flip every
 * already-persisted capacity gate to an error and redden the cycle-error bar across the whole
 * window — the measure-across-a-fix-boundary trap this module was built to prevent, re-entered
 * through the back door. Delete these only once no legacy-spelling row is still in the window.
 */
describe('WI-5435 — a tick persisted under the legacy reason spelling still reads as capacity', () => {
  it('normalizes the legacy spelling to the current literal at the extraction boundary', () => {
    expect(admissionDenialFrom({ admissionDenial: { reason: 'all-accounts-paused', via: 'governor' } })).toEqual({
      reason: 'rate-limit-blocked',
      via: 'governor',
    });
  });

  it('classifies a legacy-spelled governor denial as capacity, not as a genuine error', () => {
    const legacyRow = {
      admissionDenial: { reason: 'all-accounts-paused', via: 'governor', pausedAccounts: 1, totalAccounts: 2 },
      capacityClassifierVersion: CAPACITY_CLASSIFIER_SCHEMA_VERSION,
    };
    expect(isCapacityError(legacyRow)).toBe(true);
    expect(isPersistedCapacityError(legacyRow)).toBe(true);
  });

  it('does not smuggle the legacy spelling past the evidence requirement', () => {
    // Normalization is a spelling fix, not an exemption: an unattested legacy row still
    // fails CLOSED exactly like an unattested current-spelling one.
    expect(isCapacityError({ admissionDenial: { reason: 'all-accounts-paused', pausedAccounts: 1 } })).toBe(false);
  });
});

describe('isCapacityError — evidence-required: an UNATTESTED denial fails CLOSED (WI-5391 Part B)', () => {
  // A denial with a capacity reason but no `via` stamp is exactly what an evidence-free
  // prose-inferring mint site would produce. It must count as a loud error — otherwise an
  // admission-path defect wearing a capacity costume vanishes from the metric built to catch it.
  it('rejects a capacity-reason denial with no via stamp', () => {
    expect(isCapacityError({ admissionDenial: { reason: 'provider-429' } })).toBe(false);
    expect(isCapacityError({ admissionDenial: { reason: 'rate-limit-blocked', pausedAccounts: 3 } })).toBe(false);
  });

  it('rejects a denial with an unrecognized via value', () => {
    expect(isCapacityError({ admissionDenial: { reason: 'provider-429', via: 'vibes' } })).toBe(false);
  });
});

describe('isCapacityError — an ADMISSION failure is NOT capacity (WI-4475 / WI-4541)', () => {
  // The exact message ideators.ts emits when the cycle's remaining budget elapsed before the
  // governor ever granted a permit. It is capacity-SHAPED, and that is precisely the trap:
  // a broken admission path (WI-4541) emits the identical message with the pool wide open.
  const neverAdmitted =
    "Scout ideator contrarian was never admitted within 420000ms — no capacity within the cycle's remaining budget (not a transport timeout)";

  it('does NOT classify a never-admitted ideator as capacity — it stays a loud error', () => {
    expect(isCapacityError({ admissionDenial: { reason: 'no-free-slot', freeSlots: 0 } })).toBe(false);
  });

  it('does not accidentally match on the phrase "no capacity" (the message says it in prose)', () => {
    // Guards the substring-matching implementation: the classifier must key on the PROVIDER's
    // signal, never on our own prose about capacity — otherwise our error text steers our metric.
    expect(isCapacityError(neverAdmitted)).toBe(false);
  });

  it('does NOT classify a GENERATION timeout as capacity (the model was streaming)', () => {
    expect(
      isCapacityError(
        'Scout ideator analogical timed out after 180000ms of GENERATION (admitted — the model was streaming; this is not a capacity wait)',
      ),
    ).toBe(false);
  });

  it('does NOT classify the legacy bare timeout as capacity (ambiguous — fail loud)', () => {
    expect(isCapacityError('Scout ideator reframing timed out after 180000ms')).toBe(false);
  });

  it('does not classify a genuine cycle defect as capacity', () => {
    expect(isCapacityError('TypeError: cannot read property "ideas" of undefined')).toBe(false);
    expect(isCapacityError('invalid JSON in ideator response')).toBe(false);
    expect(isCapacityError('')).toBe(false);
  });
});

describe('persisted capacity classification across the typed-carrier transition', () => {
  const legacy429 =
    'scout: all 1 ideator LLM call(s) failed — transport death: 429 {"error":{"type":"rate_limit_error"}}';

  it('recognizes only the historical provider-ceiling signatures in the compatibility helper', () => {
    expect(isLegacyCapacityError({ error: 'rate-limit pause exceeds maxWait' })).toBe(true);
    expect(isLegacyCapacityError({ error: legacy429 })).toBe(true);
    expect(isLegacyCapacityError({ error: 'Scout ideator analogical timed out after 180000ms' })).toBe(false);
    expect(isLegacyCapacityError({ error: 'no capacity within the cycle budget' })).toBe(false);
  });

  it('uses prose only for unversioned legacy rows', () => {
    expect(isPersistedCapacityError({ error: legacy429 })).toBe(true);
    expect(
      isPersistedCapacityError({
        error: legacy429,
        capacityClassifierVersion: CAPACITY_CLASSIFIER_SCHEMA_VERSION,
      }),
    ).toBe(false);
  });

  it('keeps typed evidence authoritative regardless of the persisted version', () => {
    expect(
      isPersistedCapacityError({
        error: 'opaque',
        capacityClassifierVersion: CAPACITY_CLASSIFIER_SCHEMA_VERSION,
        admissionDenial: { reason: 'rate-limit-blocked', via: 'governor' },
      }),
    ).toBe(true);
  });

  it('does NOT let an unattested denial on a versioned row reach the capacity bucket', () => {
    // Part-A-window shape: typed reason, no via stamp. Fail closed on read too.
    expect(
      isPersistedCapacityError({
        error: 'opaque',
        capacityClassifierVersion: CAPACITY_CLASSIFIER_SCHEMA_VERSION,
        admissionDenial: { reason: 'provider-429' },
      }),
    ).toBe(false);
  });
});

describe('capacityContradicted — the write path counted it, the read path must not un-count it (WI-5391 Part B)', () => {
  const contradictedDetail = {
    error: '429 from gateway',
    capacityClassifierVersion: CAPACITY_CLASSIFIER_SCHEMA_VERSION,
    admissionDenial: { reason: 'provider-429', via: 'http-429' },
    capacityContradicted: true,
    poolSnapshot: { probedAtMs: 1, healthyAccounts: 3, codexConfigured: false },
  };

  it('reads the flag from a persisted detail', () => {
    expect(capacityContradictedFrom(contradictedDetail)).toBe(true);
    expect(capacityContradictedFrom({ capacityContradicted: 'yes' })).toBe(false);
    expect(capacityContradictedFrom(undefined)).toBe(false);
  });

  it('never re-excludes a contradicted row, even though its denial is attested', () => {
    // Without this override the read path (quality-metrics) would re-classify the row as
    // capacity from its attested denial — silently undoing the record-time discrimination,
    // and the metric could be greened by relabeling alone.
    expect(isCapacityError(contradictedDetail)).toBe(true); // the denial ALONE would exclude…
    expect(isPersistedCapacityError(contradictedDetail)).toBe(false); // …the contradiction wins.
  });
});

describe('pool-counter evidence round-trip (WI-5391 item 3 — governor-leg audit parity)', () => {
  it('carries pausedAccounts + totalAccounts through re-extraction', () => {
    // The scheduler re-extracts before persisting; dropping the counters there would strip
    // the only retro-audit evidence a governor-attested exclusion has.
    expect(
      admissionDenialFrom({
        admissionDenial: {
          reason: 'rate-limit-blocked',
          via: 'governor',
          governorReason: 'paused',
          pausedAccounts: 3,
          totalAccounts: 4,
        },
      }),
    ).toEqual({
      reason: 'rate-limit-blocked',
      via: 'governor',
      governorReason: 'paused',
      pausedAccounts: 3,
      totalAccounts: 4,
    });
  });

  it('drops non-numeric counters instead of trusting them', () => {
    expect(
      admissionDenialFrom({
        admissionDenial: { reason: 'provider-429', via: 'http-429', totalAccounts: 'twelve' },
      }),
    ).toEqual({ reason: 'provider-429', via: 'http-429' });
  });
});

describe('capacityFallbacksFrom — the cross-provider fallback trail (WI-5391 item 3)', () => {
  it('reads well-formed events from an error object or persisted detail', () => {
    expect(
      capacityFallbacksFrom({
        capacityFallbacks: [
          { from: 'claude-opus-4-8', to: 'chatgpt:5.5:low', succeeded: true, via: 'http-429', reason: 'provider-429' },
          { from: 'claude-opus-4-8', to: 'chatgpt:5.5:low', succeeded: false },
        ],
      }),
    ).toEqual([
      { from: 'claude-opus-4-8', to: 'chatgpt:5.5:low', succeeded: true, via: 'http-429', reason: 'provider-429' },
      { from: 'claude-opus-4-8', to: 'chatgpt:5.5:low', succeeded: false },
    ]);
  });

  it('drops malformed entries and returns undefined when nothing valid remains', () => {
    expect(
      capacityFallbacksFrom({
        capacityFallbacks: [{ from: 'x' }, 'not-an-object', { from: 1, to: 2, succeeded: 'yes' }],
      }),
    ).toBeUndefined();
    expect(capacityFallbacksFrom({ capacityFallbacks: 'not-an-array' })).toBeUndefined();
    expect(capacityFallbacksFrom(undefined)).toBeUndefined();
    expect(capacityFallbacksFrom(new Error('plain error'))).toBeUndefined();
  });
});
