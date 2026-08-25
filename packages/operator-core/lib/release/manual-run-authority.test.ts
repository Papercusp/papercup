import { describe, expect, it } from 'vitest';
import { classifyManualRunAuthority, type ManualRunAuthorityEvidence } from './manual-run-authority';

const clear = { status: 'clear' } as const;
const noSerializer = { status: 'none', reason: 'routine-not-paused' } as const;

function evidence(over: Partial<ManualRunAuthorityEvidence> = {}): ManualRunAuthorityEvidence {
  return {
    manualRun: clear,
    qualification: clear,
    serializer: noSerializer,
    readerOwnerId: 'su-reader',
    ...over,
  };
}

describe('EI-21456558908416090: manual checkpoint-run authority', () => {
  // ── CONTROL ────────────────────────────────────────────────────────────────
  // Permanent falsifiability control. A classifier that returned "withheld" unconditionally
  // would satisfy every positive case below while silently blinding the recommendation on a
  // healthy pipeline, so the negative case is the one that has to keep passing.
  it('CONTROL: no hold, no fence ⇒ authority is NOT withheld', () => {
    expect(classifyManualRunAuthority(evidence())).toBeNull();
  });

  it('CONTROL: an UNKNOWN admission does not withhold for the recommender', () => {
    // The recommender takes no action and the executor reads the same token and fails closed
    // itself, so failing closed here too would blank a diagnostic on a transient DB blip —
    // exactly when the pipeline is already unhealthy and the trace is most needed.
    const out = classifyManualRunAuthority(
      evidence({ manualRun: { status: 'unknown', reason: 'connection reset' } }),
    );
    expect(out).toBeNull();
  });

  it('a manual-run hold withholds it and reports its governing decision', () => {
    const out = classifyManualRunAuthority(
      evidence({
        manualRun: {
          status: 'held',
          hold: {
            governingRef: 'stable-candidate-related-gate-2026-08-23#D-061',
            reason: 'Scheduled fires re-armed; manual launches remain forbidden.',
          },
        },
      }),
    );
    expect(out).toMatchObject({
      withheld: true,
      governingRef: 'stable-candidate-related-gate-2026-08-23#D-061',
      source: 'manual-run-hold',
    });
    expect(out?.reason).toContain('manual launches remain forbidden');
  });

  it('a QUALIFICATION hold also withholds the manual lever', () => {
    // If no candidate may qualify, a ~55min manual suite cannot produce an actionable verdict.
    const out = classifyManualRunAuthority(
      evidence({
        qualification: {
          status: 'held',
          hold: { governingRef: 'stable-candidate-related-gate-2026-08-23#D-028' },
        },
      }),
    );
    expect(out).toMatchObject({ withheld: true, source: 'qualification-hold' });
    expect(out?.reason).toMatch(/no candidate may qualify/i);
  });

  it('mirrors the executor: a held serializer fence withholds it for everyone but its owner', () => {
    const serializer = {
      status: 'held',
      itemId: 'WI-40086',
      ownerId: 'su-serializer',
      pauseReason: 'D-012/D-013 live quiescence hold under WI-40086:',
      holdReason: 'D-016 sole serializer hold: qualification',
    } as const;

    expect(classifyManualRunAuthority(evidence({ serializer }))).toMatchObject({
      withheld: true,
      governingRef: 'WI-40086',
      source: 'serializer-fence',
    });

    // release:checkpoint-run admits the serializer itself, so recommending the verb to that
    // one reader is correct. Recommending it to anyone else names an action that provably
    // refuses.
    expect(
      classifyManualRunAuthority(evidence({ serializer, readerOwnerId: 'su-serializer' })),
    ).toBeNull();
  });

  it('prefers the most specific authority when several apply', () => {
    const out = classifyManualRunAuthority(
      evidence({
        manualRun: { status: 'held', hold: { governingRef: 'plan#D-061' } },
        qualification: { status: 'held', hold: { governingRef: 'plan#D-028' } },
      }),
    );
    // The reported ref must name the decision a reader would actually have to supersede.
    expect(out).toMatchObject({ governingRef: 'plan#D-061', source: 'manual-run-hold' });
  });
});
