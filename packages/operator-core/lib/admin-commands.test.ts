/**
 * Coverage for admin-commands' registry accessors: listCommands (the full set)
 * and getCommand (lookup by id, null when absent).
 */
import { describe, expect, it } from 'vitest';
import { getCommand, listCommands } from './admin-commands';

const commands = listCommands();

describe('admin-commands registry', () => {
  it('listCommands returns a non-empty set, each with an id + command', () => {
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.command).toBe('string');
    }
  });

  it('getCommand resolves a known id', () => {
    expect(getCommand(commands[0].id)).toBe(commands[0]);
  });

  it('getCommand returns null for an unknown id', () => {
    expect(getCommand('definitely-not-a-command')).toBeNull();
  });

  it('command ids are unique', () => {
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
  });

  it('EI-18666147162251862: start-mac-vm no longer self-matches via a bare `pgrep -f`', () => {
    // admin/run.ts spawns every command's `.command` string as `bash -lic '<the
    // whole string>'`, so the invoking shell's own cmdline contains any literal
    // pattern the command passes to `pgrep -f` / `pkill -f` — which always
    // self-matched (see scripts/proc-guard.mjs's header for a live repro), so
    // this command never actually started the VM. It must route through the
    // ancestor-excluding proc-guard instead of a bare pgrep/pkill -f.
    const cmd = getCommand('start-mac-vm');
    expect(cmd).not.toBeNull();
    expect(cmd!.command).toMatch(/proc-guard\.mjs["']?\s+check/);
    expect(cmd!.command).not.toMatch(/pgrep\s+-f/);
    expect(cmd!.command).not.toMatch(/pkill\s+-f/);
  });
});
