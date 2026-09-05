import { describe, expect, it } from 'vitest';
import { describeUnreadRun, type UnreadRunAdvisory } from './carry-note-unread-run';

/**
 * EI-19455262557905604 — coverage for the launched-but-unread advisory.
 *
 * FALSIFIABILITY (repo convention, "a MODERN module you import" tier): a guard that
 * has never failed is a guard nobody has tested, and the shared tree must never be
 * mutated to prove one CAN fail. So this file keeps a deliberately-wrong
 * implementation as a PERMANENT control, plus a calibration case the REAL subject
 * must pass. If the assertions below would pass against `naiveUnreadRun`, they are
 * not testing the discrimination this module exists for.
 */

/**
 * The wrong implementation this module deliberately is not: fire on the in-flight
 * vocabulary alone. Measured on the live corpus that is 447 of 10,475 notes (4.3%)
 * against the real subject's 132 (1.26%) — noisy enough to be the D-004 failure the
 * advisory is trying to avoid rather than repeat.
 */
function naiveUnreadRun(body: string | null | undefined, storedChecks: number): UnreadRunAdvisory | null {
  if (storedChecks > 0) return null;
  const text = (body ?? '').trim();
  if (!/\b(?:launched|in[-\s]flight|still running|not yet diagnosed)\b/i.test(text)) return null;
  return { flagged: true, note: 'naive', signals: { inFlight: ['x'], runRefs: [] } };
}

const LAUNCHED_UNREAD = [
  '## Did',
  'Kicked off the full affected suite for the auth-rate-limit change.',
  '## Left',
  'RESOLVED (6). REMAINING (5) — NOT yet diagnosed.',
  'Run is still running; output at /tmp/affected-9182.log.',
].join('\n');

describe('describeUnreadRun', () => {
  it('fires on a body with BOTH an in-flight admission and a run artifact, when no checks were stored', () => {
    const advisory = describeUnreadRun(LAUNCHED_UNREAD, 0);
    expect(advisory).not.toBeNull();
    expect(advisory?.flagged).toBe(true);
    expect(advisory?.signals.inFlight).toEqual(
      expect.arrayContaining(['not yet diagnosed', 'still running']),
    );
    expect(advisory?.signals.runRefs).toEqual(expect.arrayContaining(['/tmp/affected-9182.log']));
  });

  it('names the PREDICTED form, since pointing at `checks` without saying to omit `verified` is the miss', () => {
    const note = describeUnreadRun(LAUNCHED_UNREAD, 0)?.note ?? '';
    expect(note).toContain('checks:[{ claim, recheck }]');
    expect(note).toMatch(/omit `verified`/i);
    expect(note).toMatch(/PREDICTED/);
    // D-098's constraint: advisory, never a rejection.
    expect(note).toMatch(/advisory only; the write was kept/i);
  });

  it('is SILENT once any check row was stored — the writer has already found the affordance', () => {
    expect(describeUnreadRun(LAUNCHED_UNREAD, 1)).toBeNull();
    // Calibration: the naive control agrees here, so this case alone proves nothing
    // about discrimination. It is the structural half, and it must hold for both.
    expect(naiveUnreadRun(LAUNCHED_UNREAD, 1)).toBeNull();
  });

  it('is SILENT on in-flight prose with no run artifact — and this is where the naive control fires', () => {
    const body = 'Handed the lane to a peer; their work is still running on their side. Nothing of mine is open.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    // The control fires — proving the run-artifact requirement is load-bearing and
    // that the assertion above is not vacuously true of any implementation.
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('is SILENT on a run artifact with no in-flight admission — a note that REPORTS its result', () => {
    const body = 'Suite green: 812 passed, 0 failed. Full output kept at /tmp/affected-9182.log for the record.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    // The control is also silent here, so this case is calibration rather than
    // discrimination — it pins that a reported result cannot trip either half.
    expect(naiveUnreadRun(body, 0)).toBeNull();
  });

  it('does not fire on `launched` alone, the word that made the naive trigger unusable', () => {
    const body = 'Launched the drain fleet; four members joined and are claiming from the spec.';
    expect(describeUnreadRun(body, 0)).toBeNull();
    expect(naiveUnreadRun(body, 0)).not.toBeNull();
  });

  it('treats an empty or absent body as nothing to say', () => {
    expect(describeUnreadRun('', 0)).toBeNull();
    expect(describeUnreadRun(null, 0)).toBeNull();
    expect(describeUnreadRun(undefined, 0)).toBeNull();
  });

  it('recognises the other unread-run artifacts an agent actually writes', () => {
    for (const ref of ['bash_id abc123', 'run_in_background', 'capability:bash_output', 'build.log']) {
      const body = `Kicked it off, results pending. Handle: ${ref}.`;
      expect(describeUnreadRun(body, 0), ref).not.toBeNull();
    }
  });

  it('caps the echoed signals so the advisory stays one readable line', () => {
    const body =
      'launched, in flight, still running, not yet diagnosed, results pending — ' +
      '/tmp/a.log /tmp/b.log /tmp/c.log /tmp/d.log bash_id run_in_background';
    const advisory = describeUnreadRun(body, 0);
    expect(advisory?.signals.inFlight.length).toBeLessThanOrEqual(3);
    expect(advisory?.signals.runRefs.length).toBeLessThanOrEqual(3);
  });

  it('does not leak regex lastIndex between calls (the /g reuse bug)', () => {
    const first = describeUnreadRun(LAUNCHED_UNREAD, 0);
    const second = describeUnreadRun(LAUNCHED_UNREAD, 0);
    expect(second).toEqual(first);
    expect(second).not.toBeNull();
  });
});
