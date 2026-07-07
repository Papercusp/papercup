import { describe, it, expect } from 'vitest';
import * as TOML from '@iarna/toml';
import { mergeCodexStatusLineToml, CODEX_STATUS_LINE_ITEMS } from './papercusp-files';

const ITEMS = [...CODEX_STATUS_LINE_ITEMS];

describe('mergeCodexStatusLineToml — codex user-config status line (codex sibling of the Claude EI-8191 statusLine merge)', () => {
  it('adds [tui].status_line when entirely absent (the "no status line at all" case)', () => {
    const { toml, changed } = mergeCodexStatusLineToml('model = "gpt-5.5"\n');
    expect(changed).toBe(true);
    const parsed = TOML.parse(toml) as any;
    expect(parsed.tui.status_line).toEqual(ITEMS);
    expect(parsed.model).toBe('gpt-5.5'); // existing keys preserved
  });

  it('NEVER clobbers a user-configured status_line (personal item list)', () => {
    const raw = 'model = "gpt-5.5"\n[tui]\nstatus_line = ["run-state", "codex-version"]\n';
    const { toml, changed } = mergeCodexStatusLineToml(raw);
    expect(changed).toBe(false);
    expect(toml).toBe(raw); // returned verbatim, untouched
  });

  it('respects an explicit empty status_line ([] = "off on purpose")', () => {
    const raw = '[tui]\nstatus_line = []\n';
    const { changed } = mergeCodexStatusLineToml(raw);
    expect(changed).toBe(false);
  });

  it('handles the real-world subtable case: [tui.model_availability_nux] present, no bare status_line', () => {
    const raw = [
      'model = "gpt-5.5"',
      '[projects."/tmp"]',
      'trust_level = "trusted"',
      '[tui.model_availability_nux]',
      '"gpt-5.5" = 4',
      '',
    ].join('\n');
    const { toml, changed } = mergeCodexStatusLineToml(raw);
    expect(changed).toBe(true);
    const parsed = TOML.parse(toml) as any; // must remain valid TOML
    expect(parsed.tui.status_line).toEqual(ITEMS);
    expect(parsed.tui.model_availability_nux['gpt-5.5']).toBe(4); // subtable preserved
    expect(parsed.projects['/tmp'].trust_level).toBe('trusted');
  });

  it('is idempotent — a second merge is a no-op', () => {
    const first = mergeCodexStatusLineToml('model = "gpt-5.5"\n');
    expect(first.changed).toBe(true);
    const second = mergeCodexStatusLineToml(first.toml);
    expect(second.changed).toBe(false);
  });

  it('never clobbers unparseable TOML (returns unchanged)', () => {
    const raw = 'this is = = not valid toml [[[';
    const { toml, changed } = mergeCodexStatusLineToml(raw);
    expect(changed).toBe(false);
    expect(toml).toBe(raw);
  });
});
