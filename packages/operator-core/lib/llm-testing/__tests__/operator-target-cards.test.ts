/**
 * OperatorTarget card parsing — the state-channel OpenCardSnapshot shape.
 *
 * The voice converse SSE forwards `state-snapshot` events whose
 * `snapshot.openCards[]` rows are tooldef card-correlator OpenCardSnapshots:
 * { correlationId, prompt, presentation: { kind: 'radio'|'checkbox', options,
 * voiceAnswerable? }, fallbackText, … } — NO `kind` field. The old parser
 * required `kind`/`cardKind` and silently dropped every real chat_ask_choice
 * card, so scenario asserts (disambiguationCardRequired,
 * cardsAreVoiceAnswerable) could never see a card the brain emitted
 * (voice-persona-production-readiness P-003, found live 2026-06-07).
 */
import { describe, expect, it } from 'vitest';

import { cardFromObj } from '../targets/operator';

const SNAPSHOT_CARD = {
  correlationId: 'c-1',
  prompt: 'Approve the marketplace pipeline review?',
  dataSchemaJson: {},
  presentation: {
    kind: 'radio',
    options: [
      { id: 'yes', label: 'Yes, approve it', style: 'primary' },
      { id: 'no', label: 'No, cancel' },
    ],
    voiceAnswerable: true,
  },
  fallbackText: 'Approve the marketplace pipeline review?\n\nOptions:\n  1. Yes, approve it\n  2. No, cancel',
  allowDecline: true,
  createdAt: 0,
};

describe('cardFromObj — state-channel OpenCardSnapshot shape', () => {
  it('parses a radio-presentation snapshot card as chat:ask_choice', () => {
    const card = cardFromObj({ ...SNAPSHOT_CARD });
    expect(card).not.toBeNull();
    expect(card!.kind).toBe('chat:ask_choice');
    expect(card!.options).toEqual([
      { id: 'yes', label: 'Yes, approve it' },
      { id: 'no', label: 'No, cancel' },
    ]);
    expect(card!.voiceAnswerable).toBe(true);
  });

  it('voiceAnswerable reflects the REAL presentation flag, not fallbackText', () => {
    // ask_choice always sets fallbackText, but voiceAnswerable rides the
    // presentation only when the caller passed voiceAnswerable:true. A card
    // missing the flag must parse voiceAnswerable:false so
    // cardsAreVoiceAnswerable can catch the omission.
    const { voiceAnswerable: _drop, ...presentationNoFlag } = SNAPSHOT_CARD.presentation;
    const card = cardFromObj({ ...SNAPSHOT_CARD, presentation: presentationNoFlag });
    expect(card).not.toBeNull();
    expect(card!.voiceAnswerable).toBe(false);
  });

  it('parses a checkbox-presentation snapshot card', () => {
    const card = cardFromObj({
      ...SNAPSHOT_CARD,
      presentation: { ...SNAPSHOT_CARD.presentation, kind: 'checkbox' },
    });
    expect(card?.kind).toBe('chat:ask_choice');
  });

  it('keeps the legacy explicit-kind card shape working (fallbackText heuristic)', () => {
    const card = cardFromObj({
      kind: 'ready',
      options: [{ id: 'go', label: 'Go' }],
      fallbackText: 'Ready?',
    });
    expect(card?.kind).toBe('ready');
    expect(card?.voiceAnswerable).toBe(true);
  });

  it('returns null for an unrecognizable object', () => {
    expect(cardFromObj({ foo: 'bar' })).toBeNull();
  });
});
