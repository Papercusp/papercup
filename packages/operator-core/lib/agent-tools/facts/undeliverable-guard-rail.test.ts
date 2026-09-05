/**
 * Tests for the undeliverable-guard-rail advisory (EI-21228381584914967).
 *
 * FALSIFIABILITY. The detector's whole value is that it fires NARROWLY, so this file
 * asserts both directions permanently: the measured WI-40869 instance must fire, and
 * the three near-miss shapes (transport without a failure mode, failure mode without
 * a transport, neither in a safety slot) must NOT. A detector that widened into an
 * always-on advisory would pass the positive case alone; it fails the controls here.
 */
import { describe, expect, it } from 'vitest';
import {
  detectUndeliverableGuardRail,
  RESPONSE_ENVELOPE_SUBJECTS,
  SILENT_FAILURE_MODES,
} from './undeliverable-guard-rail';

/** The real fact from the founding incident, abbreviated but verbatim in its terms. */
const WI_40869_BODY =
  'Codex exec_command yields at its 10s yield_time_ms default, so a slow ptool call ' +
  'returns zero bytes and reads as empty success. Do not file it as a tool bug.';

describe('detectUndeliverableGuardRail', () => {
  it('fires on the measured WI-40869 instance', () => {
    const found = detectUndeliverableGuardRail(
      'guard-rail',
      'guard-rail:ptool-empty-success-is-codex-exec-not-the-tool',
      WI_40869_BODY,
    );
    expect(found).not.toBeNull();
    expect(found?.slot).toBe('guard-rail');
    expect(found?.subjectMatch).toBeTruthy();
    expect(found?.failureMatch).toBeTruthy();
  });

  it('points the author at the launch context, the only path off the response envelope', () => {
    const found = detectUndeliverableGuardRail('guard-rail', 'guard-rail:x', WI_40869_BODY);
    // The note must name a REAL, current surface: a warning that names a surface which
    // no longer exists is worse than no warning (assert.ts D-087 R5 removal).
    expect(found?.note).toContain('apps/operator/prompts/');
    expect(found?.note).toMatch(/not sufficient on its own|NOT sufficient/i);
  });

  it('fires for the other never-drop slots, which share the delivery path', () => {
    for (const slot of ['wall', 'dead-end'] as const) {
      expect(detectUndeliverableGuardRail(slot, 'k', WI_40869_BODY)).not.toBeNull();
    }
  });

  // ---- CONTROLS: each of these is a shape the detector must stay silent on. ----

  it('does NOT fire on a transport subject with no silent-failure mode', () => {
    // A guard-rail may legitimately name coord:orient while being about scoping.
    expect(
      detectUndeliverableGuardRail(
        'guard-rail',
        'guard-rail:orient-scope',
        'Pass harness explicitly to coord:orient; the session scope is per-call, not sticky.',
      ),
    ).toBeNull();
  });

  it('does NOT fire on a silent-failure mode with no transport subject', () => {
    // "empty result" about a QUERY is ordinary prose, not a transport claim.
    expect(
      detectUndeliverableGuardRail(
        'guard-rail',
        'guard-rail:absence-needs-its-population',
        'A zero-row SQL result returns nothing when the relation is wrong; verify the population first.',
      ),
    ).toBeNull();
  });

  it('does NOT fire outside a never-drop safety slot', () => {
    expect(detectUndeliverableGuardRail(null, 'ordinary-key', WI_40869_BODY)).toBeNull();
    expect(detectUndeliverableGuardRail(undefined, 'ordinary-key', WI_40869_BODY)).toBeNull();
  });

  it('does NOT fire on an empty body', () => {
    expect(detectUndeliverableGuardRail('guard-rail', '', '')).toBeNull();
  });

  it('matches on the KEY as well as the body', () => {
    const found = detectUndeliverableGuardRail(
      'guard-rail',
      'guard-rail:exec_command-yields',
      'Poll the session_id; output is truncated at the boundary.',
    );
    expect(found).not.toBeNull();
  });

  it('keeps both pattern sets non-empty (a cleared set would silence the detector)', () => {
    expect(RESPONSE_ENVELOPE_SUBJECTS.length).toBeGreaterThan(0);
    expect(SILENT_FAILURE_MODES.length).toBeGreaterThan(0);
  });
});
