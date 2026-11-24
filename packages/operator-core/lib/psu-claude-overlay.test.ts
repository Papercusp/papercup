import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPsuClaudeSettingsOverlay,
  readPsuClaudeMcpEntry,
  readPsuClaudeSettingsOverlay,
  stripLegacyPsuClaudeJson,
  stripLegacyPsuClaudeSettings,
} from './psu-claude-overlay.mjs';

const HOME = '/home/u';
const ours = (name: string) => ({ type: 'command', command: `${HOME}/.papercusp/hooks/cc/${name}` });
const foreign = { type: 'command', command: '/usr/local/bin/rtk hook claude' };

describe('applyPsuClaudeSettingsOverlay', () => {
  const overlay = {
    hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [ours('pretooluse-locks-acquire.sh')] }] },
    enabledPlugins: { 'papercusp@papercusp-local': true },
    extraKnownMarketplaces: { 'papercusp-local': { source: { source: 'directory', path: '/m' } } },
    statusLine: ours('statusline-fleet.sh'),
    enableAllProjectMcpServers: true,
  };

  it('adds the overlay to the user settings without touching the inputs', () => {
    const user = {
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }], SessionStart: [{ hooks: [foreign] }] },
      enabledPlugins: { 'other@m': true },
    };
    const snapshot = JSON.stringify(user);
    const merged = applyPsuClaudeSettingsOverlay(user, overlay);
    expect(JSON.stringify(user)).toBe(snapshot);
    expect(merged.model).toBe('opus');
    expect(merged.hooks.PreToolUse).toEqual([user.hooks.PreToolUse[0], overlay.hooks.PreToolUse[0]]);
    expect(merged.hooks.SessionStart).toEqual(user.hooks.SessionStart);
    expect(merged.enabledPlugins).toEqual({ 'other@m': true, 'papercusp@papercusp-local': true });
    expect(merged.extraKnownMarketplaces['papercusp-local']).toBeDefined();
    expect(merged.statusLine).toEqual(overlay.statusLine);
    expect(merged.enableAllProjectMcpServers).toBe(true);
  });

  it('is idempotent: re-applying never duplicates a hook', () => {
    const once = applyPsuClaudeSettingsOverlay({}, overlay);
    const twice = applyPsuClaudeSettingsOverlay(once, overlay);
    expect(twice).toEqual(once);
  });

  it('never replaces a personal statusLine', () => {
    const personal = { type: 'command', command: '~/bin/my-status' };
    expect(applyPsuClaudeSettingsOverlay({ statusLine: personal }, overlay).statusLine).toEqual(personal);
  });

  it('returns a plain copy when no overlay is installed', () => {
    expect(applyPsuClaudeSettingsOverlay({ a: 1 }, null)).toEqual({ a: 1 });
  });
});

describe('stripLegacyPsuClaudeSettings', () => {
  it('removes only Papercusp-owned hooks, plugin, marketplace and statusLine', () => {
    const cfg: Record<string, any> = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [ours('pretooluse-bash-resource-gate.sh'), foreign] }],
        PostToolUse: [{ matcher: '*', hooks: [ours('posttooluse-activity-report.sh')] }],
        SessionStart: [{ hooks: [foreign] }],
      },
      enabledPlugins: { 'papercusp@papercusp-local': true, 'other@m': true },
      extraKnownMarketplaces: { 'papercusp-local': {}, other: {} },
      statusLine: ours('statusline-fleet.sh'),
      enableAllProjectMcpServers: true,
      theme: 'dark',
    };
    const removed = stripLegacyPsuClaudeSettings(cfg, HOME);
    expect(removed).toEqual([
      'hooks.PreToolUse (1)',
      'hooks.PostToolUse (1)',
      'enabledPlugins.papercusp@papercusp-local',
      'extraKnownMarketplaces.papercusp-local',
      'statusLine',
    ]);
    expect(cfg).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }], SessionStart: [{ hooks: [foreign] }] },
      enabledPlugins: { 'other@m': true },
      extraKnownMarketplaces: { other: {} },
      enableAllProjectMcpServers: true,
      theme: 'dark',
    });
  });

  it('reports nothing on a clean file', () => {
    const cfg = { hooks: { SessionStart: [{ hooks: [foreign] }] } };
    expect(stripLegacyPsuClaudeSettings(cfg, HOME)).toEqual([]);
    expect(cfg).toEqual({ hooks: { SessionStart: [{ hooks: [foreign] }] } });
  });
});

describe('stripLegacyPsuClaudeJson', () => {
  it('removes only papercusp-su', () => {
    const cfg = { numStartups: 3, mcpServers: { 'papercusp-su': {}, other: {} } };
    expect(stripLegacyPsuClaudeJson(cfg)).toBe(true);
    expect(cfg).toEqual({ numStartups: 3, mcpServers: { other: {} } });
    expect(stripLegacyPsuClaudeJson(cfg)).toBe(false);
  });
});

describe('readers', () => {
  it('read the template and overlay from <home>/.papercusp and tolerate absence or bad JSON', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-overlay-'));
    try {
      expect(readPsuClaudeMcpEntry(home)).toBeNull();
      expect(readPsuClaudeSettingsOverlay(home)).toBeNull();
      mkdirSync(join(home, '.papercusp'));
      writeFileSync(join(home, '.papercusp', 'claude-mcp.json'), JSON.stringify({ mcpServers: { 'papercusp-su': { type: 'http', url: 'u' } } }));
      writeFileSync(join(home, '.papercusp', 'claude-settings.json'), '{ not json');
      expect(readPsuClaudeMcpEntry(home)).toEqual({ type: 'http', url: 'u' });
      expect(readPsuClaudeSettingsOverlay(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
