import { describe, expect, it } from 'vitest';
import {
  HUD_LAUNCH_NO_OWNER_MESSAGE,
  hudLaunchOpenDecision,
} from './hud-launch-open';

/**
 * WI-38009 REGRESSION GUARD.
 *
 * The bug this locks down was not a crash or a wrong value — it was SILENCE.
 * `if (!ownerId) return;` sat inline in HudView's JSX, so a launch that came
 * back without a coord owner id left the previously-open chat on screen under
 * NewSessionLauncher's already-fired SUCCESS toast. The owner read that as
 * "+ New session resumed an existing session" and filed it as a bug.
 *
 * So the assertion that matters is not "it returns something" — it is that the
 * null branch is NOT the do-nothing branch.
 */
describe('hudLaunchOpenDecision', () => {
  it('opens the chat on the pre-pinned coord owner id', () => {
    const d = hudLaunchOpenDecision('su-11111111-2222-3333-4444-555555555555');
    expect(d).toEqual({ kind: 'open', ownerId: 'su-11111111-2222-3333-4444-555555555555' });
  });

  // The branch that caused the report. It must produce a USER-VISIBLE outcome,
  // never a silent no-op.
  it('warns instead of silently doing nothing when the launch returns no ownerId', () => {
    const d = hudLaunchOpenDecision(null);
    expect(d.kind).toBe('warn');
  });

  it('warns for undefined too (a response with the field absent, not just null)', () => {
    expect(hudLaunchOpenDecision(undefined).kind).toBe('warn');
  });

  // An empty string is as unusable as null as a chat key. Letting it through
  // would call setOpenOwner('') and blank the pane — the same invisible
  // failure wearing a different value.
  it('treats an empty-string ownerId as unusable rather than opening a blank chat', () => {
    expect(hudLaunchOpenDecision('').kind).toBe('warn');
  });

  /**
   * Non-vacuity: a guard that only asserted `kind === 'warn'` would still pass
   * if the message were empty, which would render as an invisible toast and
   * restore the exact silence this exists to prevent. Assert the message
   * actually tells the user the two things they need: that the pane is STALE,
   * and that the launch nevertheless happened.
   */
  it('tells the user the pane is stale and the session still launched', () => {
    const d = hudLaunchOpenDecision(null);
    if (d.kind !== 'warn') throw new Error('expected a warn decision');
    expect(d.message).toBe(HUD_LAUNCH_NO_OWNER_MESSAGE);
    expect(d.message.trim().length).toBeGreaterThan(0);
    expect(d.message).toMatch(/PREVIOUS session/);
    expect(d.message).toMatch(/launched/i);
  });
});
