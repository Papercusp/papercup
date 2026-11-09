/**
 * Coverage for admin-commands' registry accessors: listCommands (the full set)
 * and getCommand (lookup by id, null when absent).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILD_VM_ENV_HOME_RELATIVE_PATH, getCommand, listCommands } from './admin-commands';

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

  it('loads VM config from the command runtime HOME rather than the workspace home', () => {
    const home = mkdtempSync(join(tmpdir(), 'vm config home-'));
    try {
      const config = join(home, BUILD_VM_ENV_HOME_RELATIVE_PATH);
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(config, 'VM_MAC_SSH_KEY=fixture-mac\nVM_MAC_USER=fixture-user\nVM_WIN_SSH_KEY=fixture-win\nVM_WIN_USER=fixture-win-user\n', { mode: 0o600 });
      const command = getCommand('build-mac-prod')!.command;
      const boundary = command.indexOf('\necho "=== rsync');
      expect(boundary).toBeGreaterThan(0);
      // Execute only the config prelude; never run the build, SSH or rsync.
      const output = execFileSync('bash', ['-c', `${command.slice(0, boundary)}\nprintf '%s\\n' "$VM_ENV" "$VM_MAC_USER"`], {
        env: { ...process.env, HOME: home, PAPERCUSP_HOME: join(home, 'workspace-home') },
        encoding: 'utf8', timeout: 5000,
      });
      expect(output).toBe(`${config}\nfixture-user\n`);
    } finally { rmSync(home, { recursive: true, force: true }); }
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
