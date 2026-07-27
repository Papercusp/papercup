/**
 * evidence-band.test.ts — P-010 (agent-protocol-authority-semantics-2026-07-26):
 * the evidence/provenance band on coord findings and escalations.
 *
 * Two invariants carry the item, and both are failure modes the plan names:
 *
 * 1. CONFIDENCE IS DERIVED, NEVER SELF-REPORTED (Reasoning Contamination Effect).
 *    A model asked for a numeric confidence produces one poorly correlated with
 *    accuracy, and the number then contaminates readers who take "0.9" as
 *    measured. Confidence here is a pure function of a closed band, and a sender
 *    that smuggles its own number gets it DISCARDED and flagged.
 *
 * 2. THE BAND IS DESCRIPTIVE, NEVER AUTHORITY (D-015, binding from P-009).
 *    Provenance may inform how much weight a reader gives a claim; it must never
 *    become a new route by which a conversational message drives a transition.
 *    That is asserted here directly against readCoordTransitionIntent.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/coordination/evidence-band.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  COORD_CONVERSATIONAL_KINDS,
  readCoordTransitionIntent,
} from '@papercusp/coordination/core';
import {
  EVIDENCE_BANDS,
  EVIDENCE_FIELD,
  deriveConfidence,
  hasSelfReportedConfidence,
  parseLegacyProvenanceTag,
  readEvidence,
  renderEvidenceTag,
  resolveClaimProvenance,
  RELAY_PROVENANCE_FIELD,
  type EvidenceBand,
} from './relay-provenance';

const env = (evidence: unknown, extra: Record<string, unknown> = {}) => ({
  ts: '2026-07-27T00:00:00.000Z',
  msg_id: 'm1',
  from: 'su-peer',
  to: ['su-me'],
  kind: 'escalation',
  summary: 'something looks wrong',
  [EVIDENCE_FIELD]: evidence,
  ...extra,
});

describe('P-010 — confidence is DERIVED, never self-reported', () => {
  it('maps every band to a confidence (total over the closed set)', () => {
    for (const band of EVIDENCE_BANDS) {
      expect(['high', 'medium', 'low']).toContain(deriveConfidence(band));
    }
    expect(deriveConfidence('observed')).toBe('high');
    expect(deriveConfidence('tool-output')).toBe('high');
    expect(deriveConfidence('reported-by')).toBe('medium');
    expect(deriveConfidence('inferred')).toBe('low');
    expect(deriveConfidence('assumed')).toBe('low');
  });

  it('grounded bands outrank ungrounded ones — a claim cannot be inflated by asserting', () => {
    // To claim HIGH you must claim you observed it or have tool output: a
    // checkable statement about the world, not a vibe.
    const high = EVIDENCE_BANDS.filter((b) => deriveConfidence(b) === 'high');
    expect([...high].sort()).toEqual(['observed', 'tool-output']);
  });

  it('detects a self-reported confidence in every smuggling shape', () => {
    expect(hasSelfReportedConfidence({ confidence: 0.92 })).toBe(true);
    expect(hasSelfReportedConfidence({ certainty: 95 })).toBe(true);
    expect(hasSelfReportedConfidence({ probability: '0.8' })).toBe(true);
    expect(hasSelfReportedConfidence({ confidence: '90%' })).toBe(true);
    expect(hasSelfReportedConfidence({ confidence: 'high' })).toBe(false); // prose, not a number
    expect(hasSelfReportedConfidence({})).toBe(false);
    expect(hasSelfReportedConfidence(null)).toBe(false);
  });

  it('a self-reported number is DISCARDED — the band still decides', () => {
    const resolved = resolveClaimProvenance(
      env({ band: 'assumed' }, { confidence: 0.99 }),
    );
    // The sender asked for 0.99; the band says `assumed`, so confidence is low.
    expect(resolved.confidence).toBe('low');
    expect(resolved.selfReportedConfidenceDiscarded).toBe(true);
    expect(resolved.basis).toBe('evidence-band');
  });

  it('renders confidence as derived, never as a bare number', () => {
    expect(renderEvidenceTag({ band: 'tool-output' })).toBe('tool-output (confidence: high)');
    expect(renderEvidenceTag({ band: 'reported-by', reportedBy: 'su-709bb' })).toBe(
      'reported-by:su-709bb (confidence: medium)',
    );
    expect(renderEvidenceTag({ band: 'observed', ref: 'handoffs.ts:43' })).toBe(
      'observed handoffs.ts:43 (confidence: high)',
    );
  });
});

describe('P-010 — reading + validating the stamp', () => {
  it('reads a well-formed stamp', () => {
    expect(readEvidence(env({ band: 'observed', ref: 'tsc exit 2' }))).toEqual({
      band: 'observed',
      ref: 'tsc exit 2',
    });
  });

  it('REJECTS a reported-by with no attribution — an unattributed relay is the collapse', () => {
    expect(readEvidence(env({ band: 'reported-by' }))).toBeNull();
    expect(readEvidence(env({ band: 'reported-by', reportedBy: '   ' }))).toBeNull();
    expect(readEvidence(env({ band: 'reported-by', reportedBy: 'su-709bb' }))).toEqual({
      band: 'reported-by',
      reportedBy: 'su-709bb',
    });
  });

  it('is defensive — malformed or unknown bands yield null, never throw', () => {
    expect(readEvidence(null)).toBeNull();
    expect(readEvidence(undefined)).toBeNull();
    expect(readEvidence({})).toBeNull();
    expect(readEvidence(env('observed'))).toBeNull(); // string, not an object
    expect(readEvidence(env({ band: 'definitely-not-a-band' }))).toBeNull();
    expect(readEvidence(env({ band: 'CERTAIN' }))).toBeNull();
  });
});

describe('P-010 — the legacy compaction tags map onto the band', () => {
  it('parses each documented tag', () => {
    expect(parseLegacyProvenanceTag('note [self-imposed] here')).toEqual({ band: 'assumed' });
    expect(parseLegacyProvenanceTag('note [inferred]')).toEqual({ band: 'inferred' });
    expect(parseLegacyProvenanceTag('[peer:su-709bb] said so')).toEqual({
      band: 'reported-by',
      reportedBy: 'su-709bb',
    });
  });

  it('an [owner:…] PROSE tag is only a CLAIM of owner origin — never owner-verified', () => {
    // EI-9501 / WI-3532: prose asserting owner origin is exactly the telephone
    // game. It maps to reported-by (medium), NOT to anything higher; only a
    // platform-verified relay tier can establish owner origin.
    const stamp = parseLegacyProvenanceTag('[owner:<name> 2026-07-11] do the thing');
    expect(stamp?.band).toBe('reported-by');
    expect(deriveConfidence(stamp!.band)).toBe('medium');
    expect(deriveConfidence(stamp!.band)).not.toBe('high');
  });

  it('returns null when no tag is present', () => {
    expect(parseLegacyProvenanceTag('just some prose')).toBeNull();
    expect(parseLegacyProvenanceTag('')).toBeNull();
  });
});

describe('P-010 — precedence: platform-verified outranks self-declared', () => {
  it('a VERIFIED relay tier outranks a weak self-declared band', () => {
    const resolved = resolveClaimProvenance(
      env({ band: 'assumed' }, {
        [RELAY_PROVENANCE_FIELD]: { tier: 'owner-verified-turn', quote: 'do the thing' },
      }),
    );
    expect(resolved.basis).toBe('relay-verified');
    expect(resolved.confidence).toBe('high');
  });

  it('an UNVERIFIED relay tier outranks NOTHING — a failed check is not a weak pass', () => {
    const resolved = resolveClaimProvenance(
      env({ band: 'assumed' }, {
        [RELAY_PROVENANCE_FIELD]: { tier: 'unverified', quote: 'the owner said so' },
      }),
    );
    expect(resolved.basis).toBe('evidence-band');
    expect(resolved.confidence).toBe('low');
  });

  it('reports basis `none` when neither stamp is present', () => {
    const resolved = resolveClaimProvenance({ kind: 'message', summary: 'hi' });
    expect(resolved.basis).toBe('none');
    expect(resolved.confidence).toBeNull();
  });
});

describe('P-010 × D-015 — the band is DESCRIPTIVE, never transition authority', () => {
  it('no evidence band lets a CONVERSATIONAL kind drive a transition', () => {
    for (const kind of COORD_CONVERSATIONAL_KINDS) {
      for (const band of EVIDENCE_BANDS) {
        const candidate = env({ band, reportedBy: 'su-peer' }, { kind });
        expect(
          readCoordTransitionIntent(candidate),
          `band '${band}' must not make '${kind}' executable`,
        ).toBeNull();
      }
    }
  });

  it('even the STRONGEST band on the most authoritative-looking message is inert', () => {
    const candidate = env(
      { band: 'tool-output', ref: 'tsc exit 0' },
      {
        kind: 'message',
        related_msg_id: 'h1',
        body: 'tool-output confirms the handoff is accepted',
        [RELAY_PROVENANCE_FIELD]: { tier: 'owner-verified-turn', quote: 'accept it' },
      },
    );
    // Highest possible provenance on both axes — still not a transition.
    expect(resolveClaimProvenance(candidate).confidence).toBe('high');
    expect(readCoordTransitionIntent(candidate)).toBeNull();
  });

  it('provenance never rides INTO a transition intent, even on an executable kind', () => {
    const intent = readCoordTransitionIntent(
      env({ band: 'observed' }, {
        kind: 'handoff_accepted',
        related_msg_id: 'h1',
        [RELAY_PROVENANCE_FIELD]: { tier: 'owner-verified-turn', quote: 'q' },
      }),
    );
    expect(intent).not.toBeNull();
    expect(intent as object).not.toHaveProperty(EVIDENCE_FIELD);
    expect(intent as object).not.toHaveProperty(RELAY_PROVENANCE_FIELD);
    expect(Object.keys(intent as object).sort()).toEqual(
      ['from', 'kind', 'msg_id', 'related_msg_id', 'to', 'ts'].sort(),
    );
  });

  it('the band cannot be widened into the executable vocabulary by accident', () => {
    // A band value that happens to collide with a kind name is still just a band.
    const bands: readonly string[] = EVIDENCE_BANDS;
    for (const b of bands) expect(readCoordTransitionIntent(env({ band: b as EvidenceBand }, { kind: b }))).toBeNull();
  });
});
