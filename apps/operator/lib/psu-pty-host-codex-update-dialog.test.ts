// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CODEX_STARTUP_UPDATE_DIALOG_ESCAPE_KEY,
  managedCodexStartupUpdateDialogEnabled,
  makeManagedCodexStartupUpdateDialogStateMachine,
} from '../scripts/psu-pty-host.mjs';

const codexUpdateMenu = [
  '\x1b[?1049h\x1b[2;1HUpdate available 0.161.0 → 0.162.0',
  '\x1b[3;1H› 1. Update now',
  '\x1b[4;1H  2. Skip',
  '\x1b[5;1H  3. Skip until next version',
].join('');

describe('managed Codex startup update dialog', () => {
  it('is enabled only for the managed Codex agent', () => {
    expect(managedCodexStartupUpdateDialogEnabled({ PAPERCUSP_AGENT: 'codex' })).toBe(true);
    expect(managedCodexStartupUpdateDialogEnabled({ PAPERCUSP_AGENT: 'CODEX' })).toBe(true);
    expect(managedCodexStartupUpdateDialogEnabled({ PAPERCUSP_AGENT: 'claude' })).toBe(false);
    expect(managedCodexStartupUpdateDialogEnabled({})).toBe(false);

    const disabled = makeManagedCodexStartupUpdateDialogStateMachine({
      enabled: managedCodexStartupUpdateDialogEnabled({ PAPERCUSP_AGENT: 'claude' }),
    });
    expect(disabled.observe(codexUpdateMenu)).toMatchObject({ action: 'none', phase: 'disabled', active: false });
  });

  it('recognizes the exact current menu across split ANSI and text chunks, then requests Escape once', () => {
    let now = 1_000;
    const dialog = makeManagedCodexStartupUpdateDialogStateMachine({
      now: () => now,
      screenDims: { rows: 8, cols: 80 },
    });

    expect(dialog.observe('\x1b[?1049h\x1b[2;')).toMatchObject({ action: 'none', phase: 'watching' });
    expect(dialog.observe('1H\x1b[1;3')).toMatchObject({ action: 'none', phase: 'watching' });
    expect(dialog.observe('2mUpdate available 0.161.0 → 0.162.0\x1b[0m')).toMatchObject({
      action: 'none', phase: 'watching',
    });
    expect(dialog.observe('\x1b[3;1H› 1. Update now')).toMatchObject({ action: 'none', phase: 'watching' });
    expect(dialog.observe('\x1b[4;1H  2. Skip')).toMatchObject({ action: 'none', phase: 'watching' });
    expect(dialog.observe('\x1b[5;1H  3. Skip until next version')).toMatchObject({
      action: 'send-escape', phase: 'complete', active: false,
    });
    expect(CODEX_STARTUP_UPDATE_DIALOG_ESCAPE_KEY).toBe('\x1b');
    expect(dialog.observe(codexUpdateMenu)).toMatchObject({ action: 'none', phase: 'complete', active: false });
    now += 1;
    expect(dialog.status()).toMatchObject({ phase: 'complete', active: false });
  });

  it('ignores ordinary startup prose and menus missing any exact choice', () => {
    const prose = makeManagedCodexStartupUpdateDialogStateMachine({ screenDims: { rows: 8, cols: 80 } });
    expect(prose.observe(
      '\x1b[?1049h\x1b[2;1HUpdate available: choose Update now, Skip, or Skip until next version.',
    )).toMatchObject({ action: 'none', phase: 'watching' });

    const incomplete = makeManagedCodexStartupUpdateDialogStateMachine({ screenDims: { rows: 8, cols: 80 } });
    expect(incomplete.observe(codexUpdateMenu.replace('3. Skip until next version', '3. Keep current version')))
      .toMatchObject({ action: 'none', phase: 'watching' });
  });

  it('expires after the bounded startup window and disarms on the first submitted turn', () => {
    let now = 4_000;
    const expired = makeManagedCodexStartupUpdateDialogStateMachine({
      now: () => now,
      startupMs: 100,
      screenDims: { rows: 8, cols: 80 },
    });
    now += 100;
    expect(expired.observe(codexUpdateMenu)).toMatchObject({ action: 'expired', phase: 'expired', active: false });
    expect(expired.observe(codexUpdateMenu)).toMatchObject({ action: 'none', phase: 'expired', active: false });

    const submitted = makeManagedCodexStartupUpdateDialogStateMachine({ screenDims: { rows: 8, cols: 80 } });
    submitted.complete();
    expect(submitted.observe(codexUpdateMenu)).toMatchObject({ action: 'none', phase: 'complete', active: false });
  });
});
