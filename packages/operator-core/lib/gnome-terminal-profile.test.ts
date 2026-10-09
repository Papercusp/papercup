// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GNOME_SESSION_PROFILE_UUID, prepareGnomeTerminal } from './gnome-terminal-profile.mjs';

vi.mock('node:fs', () => ({ readFileSync: () => "#!/usr/bin/python3\nparser.add_argument('--disable-factory', action='store_true')" }));

describe('new GNOME window profile preparation', () => {
  it('keeps explicit profile selections and other emulators untouched', async () => {
    const run = vi.fn();
    for (const terminal of [
      { bin: 'xterm', args: ['-e'] },
      { bin: 'gnome-terminal', args: ['--profile=personal', '--'] },
      { bin: 'gnome-terminal', args: ['--profile', 'personal', '--'] },
    ]) {
      const prepared = await prepareGnomeTerminal(terminal, {}, run);
      if (terminal.bin === 'xterm') expect(prepared).toBe(terminal);
      else expect(prepared.args).toEqual(['--disable-factory', ...terminal.args]);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('selects the bounded copy only after verifying that the default was preserved', async () => {
    const run = vi.fn(async (_file: string, _args: string[], _options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => ({ stdout: JSON.stringify({ profileUuid: GNOME_SESSION_PROFILE_UUID,
      scrollbackLines: 10000, defaultProfileUuid: 'original', sourceProfileUuid: 'original', sourceUnlimited: true }) }));
    const terminal = { bin: '/usr/bin/gnome-terminal', args: ['--wait', '--window', '--'] };
    expect(await prepareGnomeTerminal(terminal, { DISPLAY: ':isolated' }, run)).toEqual({
      bin: terminal.bin, args: ['--profile=' + GNOME_SESSION_PROFILE_UUID, '--disable-factory', '--wait', '--window', '--'],
    });
    expect(terminal.args).toEqual(['--wait', '--window', '--']);
    expect(run.mock.calls[0][2].env).toEqual({ DISPLAY: ':isolated' });
  });

  it('refuses malformed receipts or a changed default instead of silently launching an unverified profile', async () => {
    const terminal = { bin: 'gnome-terminal', args: ['--'] };
    await expect(prepareGnomeTerminal(terminal, {}, async () => ({ stdout: '' }))).rejects.toThrow('valid receipt');
    await expect(prepareGnomeTerminal(terminal, {}, async () => ({ stdout: JSON.stringify({
      profileUuid: GNOME_SESSION_PROFILE_UUID, scrollbackLines: 10000,
      defaultProfileUuid: 'changed', sourceProfileUuid: 'original', sourceUnlimited: true,
    }) }))).rejects.toThrow('preserved default');
    const run = vi.fn(async () => ({ stdout: '{"profileUuid":null,"created":false}' }));
    expect((await prepareGnomeTerminal(terminal, {}, run)).args).toEqual(['--disable-factory', '--']);
  });
});
