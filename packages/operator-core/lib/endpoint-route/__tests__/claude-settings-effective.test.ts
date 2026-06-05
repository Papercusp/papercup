/**
 * effectiveClaudeSettings / mergeSettings (D-013, pui-completion-and-polish-
 * 2026-06-05): the Config tab renders *effective* Claude Code settings —
 * `CLAUDE_SETTINGS_DEFAULTS` overlaid by the harness's `.claude/settings.json`
 * — so an empty file shows the real default structure, a partial file
 * deep-merges (file wins per key), and a broken file degrades to defaults
 * with a surfaced parseError instead of a blank tab.
 */
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_SETTINGS_DEFAULTS,
  effectiveClaudeSettings,
  mergeSettings,
} from '../routes/harness/config-files';

describe('effectiveClaudeSettings', () => {
  it('empty/missing content → pure defaults, no fileKeys', () => {
    for (const content of ['', '   \n', null, undefined]) {
      const v = effectiveClaudeSettings(content);
      expect(v.parsed).toBeNull();
      expect(v.parseError).toBeUndefined();
      expect(v.effective).toEqual(CLAUDE_SETTINGS_DEFAULTS);
      expect(v.fileKeys).toEqual([]);
    }
  });

  it('file scalar overrides the default; untouched defaults remain', () => {
    const v = effectiveClaudeSettings(JSON.stringify({ model: 'claude-opus-4-8' }));
    expect(v.effective.model).toBe('claude-opus-4-8');
    expect(v.effective.includeCoAuthoredBy).toBe(true);
    expect(v.fileKeys).toEqual(['model']);
  });

  it('partial nested object deep-merges — sibling default keys survive', () => {
    const v = effectiveClaudeSettings(
      JSON.stringify({ permissions: { allow: ['Bash(npm run test:*)'] } }),
    );
    const perms = v.effective.permissions as Record<string, unknown>;
    expect(perms.allow).toEqual(['Bash(npm run test:*)']);
    expect(perms.deny).toEqual([]); // default sibling kept
    expect(perms.defaultMode).toBe('default');
  });

  it('arrays replace, never concat', () => {
    const v = effectiveClaudeSettings(
      JSON.stringify({ enabledMcpjsonServers: ['papercusp-su'] }),
    );
    expect(v.effective.enabledMcpjsonServers).toEqual(['papercusp-su']);
  });

  it('keys unknown to the defaults pass through', () => {
    const v = effectiveClaudeSettings(JSON.stringify({ statusLine: { type: 'command' } }));
    expect(v.effective.statusLine).toEqual({ type: 'command' });
    expect(v.fileKeys).toEqual(['statusLine']);
  });

  it('invalid JSON → defaults + parseError', () => {
    const v = effectiveClaudeSettings('{nope');
    expect(v.parsed).toBeNull();
    expect(v.parseError).toMatch(/invalid JSON/);
    expect(v.effective).toEqual(CLAUDE_SETTINGS_DEFAULTS);
  });

  it('non-object JSON root → defaults + parseError', () => {
    for (const bad of ['[1,2]', '"str"', '42', 'null']) {
      const v = effectiveClaudeSettings(bad);
      expect(v.parseError).toBe('settings root must be a JSON object');
      expect(v.effective).toEqual(CLAUDE_SETTINGS_DEFAULTS);
    }
  });

  it('does not mutate the defaults object', () => {
    const before = JSON.parse(JSON.stringify(CLAUDE_SETTINGS_DEFAULTS));
    effectiveClaudeSettings(JSON.stringify({ permissions: { allow: ['X'] }, env: { A: '1' } }));
    expect(CLAUDE_SETTINGS_DEFAULTS).toEqual(before);
  });
});

describe('mergeSettings', () => {
  it('null overlay value replaces (clears) an object default', () => {
    expect(mergeSettings({ hooks: { a: 1 } }, { hooks: null })).toEqual({ hooks: null });
  });

  it('nested merge is recursive', () => {
    expect(
      mergeSettings({ a: { b: { c: 1, d: 2 } } }, { a: { b: { c: 9 } } }),
    ).toEqual({ a: { b: { c: 9, d: 2 } } });
  });
});
