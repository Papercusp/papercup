import { describe, it, expect } from 'vitest';
import { isExitedPaneScreen } from './papercup-input';

/**
 * Guards the exited-pane detection that keeps voice-in from typing into a zellij
 * pane held at the re-run prompt (where the trailing Enter would re-run the
 * command and lose the turn). The markers come from zellij 0.44's held-frame
 * footer: `<ENTER> re-run … Ctrl-c exit [ EXIT CODE: N ] EXITED`.
 */
describe('isExitedPaneScreen', () => {
  it('detects a zellij command pane held at the re-run prompt', () => {
    const dump = [
      'psu: sentinel on claude',
      '$ psu-sentinel',
      'Session ended.',
      ' <ENTER> re-run, <ESC> close, Ctrl-c exit  [ EXIT CODE: 1 ] EXITED ',
    ].join('\n');
    expect(isExitedPaneScreen(dump)).toBe(true);
  });

  it('detects the held frame even with color ANSI styling present', () => {
    const dump = '\x1b[31m <ENTER> re-run \x1b[0m Ctrl-c exit \x1b[1m[ EXIT CODE: 0 ] EXITED\x1b[0m';
    expect(isExitedPaneScreen(dump)).toBe(true);
  });

  it('returns false for a normal, running composer pane', () => {
    const dump = [
      '❯ Try "how do I log an error?"',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      '  papercusp · ◇ role-e0616 · 2 peers · ◆ e8643f',
    ].join('\n');
    expect(isExitedPaneScreen(dump)).toBe(false);
  });

  it('does NOT false-positive on chat that mentions only an exit code', () => {
    // Requiring BOTH `EXIT CODE:` and a `re-run` hint means an ordinary mention of
    // an exit code (the common case) cannot be mistaken for the held frame.
    expect(isExitedPaneScreen('The deploy exited with exit code: 137 (OOM).')).toBe(false);
    expect(isExitedPaneScreen('Should I re-run the migration? It is idempotent.')).toBe(false);
  });

  it('returns false for empty / unrelated output', () => {
    expect(isExitedPaneScreen('')).toBe(false);
    expect(isExitedPaneScreen('just some normal terminal text\nwith no markers')).toBe(false);
  });
});
