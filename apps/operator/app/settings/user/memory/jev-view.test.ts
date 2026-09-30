/**
 * The "Jev decisions" card's wording rules (plan jev-decision-model-integration-2026-09-29,
 * P-013 / D-008). The rule these pin: "in use" follows the server's EFFECTIVE mode,
 * so a chosen mode with no key saved reads as the current system, never as Jev.
 */
import { describe, expect, it } from 'vitest';
import {
  JEV_KEY_CONFLICT_USE,
  JEV_KEY_MIN_LENGTH,
  JEV_MEASURED_VERDICT,
  JEV_MODE_OPTIONS,
  jevKeyDraftProblem,
  jevView,
  type JevSettingsEnvelopeView,
} from './jev-view';

function envelope(over: Partial<JevSettingsEnvelopeView> = {}): JevSettingsEnvelopeView {
  return { mode: 'off', keyPresent: false, maskedKey: null, effective: 'off', model: 'jev-1.13.0', ...over };
}

describe('jevView', () => {
  it('off with no key: the current system, no calls, no warning', () => {
    const v = jevView(envelope());
    expect(v.choice).toBe('off');
    expect(v.inUse).toBe('The current system. Jev makes no calls.');
    expect(v.missingKeyWarning).toBeNull();
    expect(v.keyLine).toBe('No key saved');
  });

  // WI-10004278: with a key saved, Off still sends new memories to Jev for the
  // contradiction check, so the card must not claim that Jev makes no calls.
  it('off with a key saved: the current system, and it does not claim Jev makes no calls', () => {
    const v = jevView(envelope({ mode: 'off', keyPresent: true, maskedKey: 'ab1...cd34', effective: 'off' }));
    expect(v.inUse).toContain('The current system.');
    expect(v.inUse).not.toContain('makes no calls');
    expect(v.inUse).toContain('contradiction checks');
    expect(v.missingKeyWarning).toBeNull();
  });

  it('a chosen mode with no key saved reads as the current system and warns, whatever the stored choice', () => {
    for (const mode of ['shadow', 'on'] as const) {
      const v = jevView(envelope({ mode, keyPresent: false, effective: 'off' }));
      expect(v.choice).toBe(mode);
      expect(v.inUse).toBe('The current system. Jev makes no calls.');
      expect(v.missingKeyWarning).toContain('no key is saved');
      expect(v.missingKeyWarning).toContain(mode === 'on' ? 'set to On' : 'set to Log only');
    }
  });

  it('shadow with a key: current system in use, Jev only logged, pinned model named', () => {
    const v = jevView(envelope({ mode: 'shadow', keyPresent: true, maskedKey: 'fake…aaaa', effective: 'shadow' }));
    expect(v.inUse).toContain('The current system.');
    expect(v.inUse).toContain('only logged');
    expect(v.inUse).toContain('jev-1.13.0');
    expect(v.missingKeyWarning).toBeNull();
    expect(v.keyLine).toBe('Saved: fake…aaaa');
  });

  it('on with a key: Jev decides, with the current system as the fallback', () => {
    const v = jevView(envelope({ mode: 'on', keyPresent: true, maskedKey: 'fake…aaaa', effective: 'on' }));
    expect(v.inUse).toContain("Jev's decision (jev-1.13.0)");
    expect(v.inUse).toContain('current system is used whenever Jev');
    expect(v.missingKeyWarning).toBeNull();
  });

  it('never renders the raw key: the key line is built only from maskedKey', () => {
    const v = jevView(envelope({ keyPresent: true, maskedKey: null }));
    expect(v.keyLine).toBe('Saved: a key is stored');
  });

  it('offers exactly the three server modes, Off first', () => {
    expect(JEV_MODE_OPTIONS.map((o) => o.value)).toEqual(['off', 'shadow', 'on']);
  });
});

describe('the key also drives contradiction checks (P-009 / D-016)', () => {
  it('says the key checks new memories, that this runs even under Off, and that a contradiction is refused', () => {
    expect(JEV_KEY_CONFLICT_USE).toContain('check each new memory for contradictions');
    expect(JEV_KEY_CONFLICT_USE).toContain('in every mode including Off');
    expect(JEV_KEY_CONFLICT_USE).toContain('is refused unless it is saved with force or the older memory is removed first');
  });
});

describe('jevKeyDraftProblem', () => {
  it('accepts a plausible key, trimming surrounding whitespace', () => {
    expect(jevKeyDraftProblem('  fake-jev-key-aaaaaaaa  ')).toBeNull();
  });

  it('rejects an empty draft, a short key, and embedded whitespace', () => {
    expect(jevKeyDraftProblem('   ')).toContain('Paste');
    expect(jevKeyDraftProblem('a'.repeat(JEV_KEY_MIN_LENGTH - 1))).toContain('too short');
    expect(jevKeyDraftProblem('fake-jev key-aaaaaaaa')).toContain('spaces');
  });

  it('mirrors the server minimum, so it never blocks a key the server would accept', () => {
    expect(jevKeyDraftProblem('a'.repeat(JEV_KEY_MIN_LENGTH))).toBeNull();
  });
});

describe('the measured verdict beside the mode control (D-013, superseding D-012)', () => {
  it('states when and on which model it was measured, the numbers, and that Off stays the default', () => {
    expect(JEV_MEASURED_VERDICT).toContain('2026-09-30');
    expect(JEV_MEASURED_VERDICT).toContain('jev-1.13.0');
    expect(JEV_MEASURED_VERDICT).toContain('0 to 1 times in 30');
    expect(JEV_MEASURED_VERDICT).toContain('8 in 30');
    expect(JEV_MEASURED_VERDICT).toMatch(/borderline/);
    expect(JEV_MEASURED_VERDICT).toMatch(/Off stays the default/);
  });

  it("no longer carries D-012's state-encoding verdict", () => {
    expect(JEV_MEASURED_VERDICT).not.toMatch(/not recommended|1 in 10/i);
  });
});
