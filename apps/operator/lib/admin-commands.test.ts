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
});
