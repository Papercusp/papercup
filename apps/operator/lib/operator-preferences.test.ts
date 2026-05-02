import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We need to override papercuspPath() before importing the module under
// test so it points at a fresh tmp dir per test.
const tmpRoot = mkdtempSync(join(tmpdir(), 'op-prefs-'));
vi.mock('./papercusp-root', () => ({
  papercuspPath: (...parts: string[]) => join(tmpRoot, ...parts),
}));
// Stub the workspace registry so unrelated imports don't try to read PG.
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'test-ws',
}));

import {
  appendPreferenceEntry,
  listPreferenceEntries,
  removePreferenceEntry,
  parseStandingApprovals,
} from './operator-preferences';

const PREFS = join(tmpRoot, 'system', 'operator', 'preferences.md');

beforeEach(() => {
  try {
    writeFileSync(PREFS, '');
  } catch {
    /* dir not yet created — appendPreferenceEntry will mkdir */
  }
});

afterEach(() => {
  try {
    rmSync(PREFS);
  } catch {
    /* not present */
  }
});

describe('appendPreferenceEntry', () => {
  it('groups same-day entries under one ## YYYY-MM-DD header', () => {
    appendPreferenceEntry('- [USER-TYPED] [DISMISS] "X" — reason: "y"');
    appendPreferenceEntry('- [USER-TYPED] [DISMISS] "Z" — reason: "w"');
    const raw = readFileSync(PREFS, 'utf8');
    expect(raw.match(/^## /gm)?.length).toBe(1);
    expect(raw).toContain('"X"');
    expect(raw).toContain('"Z"');
  });
});

describe('listPreferenceEntries', () => {
  it('parses entries with their tags', () => {
    appendPreferenceEntry('- [USER-TYPED] [DISMISS] "Run validator" — reason: "already ran"');
    appendPreferenceEntry('- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-05-02] [STANDING-APPROVE]\n  capability=tasks:write, target=foo');
    const entries = listPreferenceEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].tags).toContain('USER-TYPED');
    expect(entries[1].tags).toContain('STANDING-APPROVE');
  });
});

describe('parseStandingApprovals', () => {
  it('extracts (capability, target) from a standing approval line', () => {
    const md = `## 2026-05-01
- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-05-01] [STANDING-APPROVE]
  capability=messages:write, target=architect-foo
`;
    const out = parseStandingApprovals(md);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      capability: 'messages:write',
      targetHarness: 'architect-foo',
      confirmedAt: '2026-05-01',
    });
  });
});

describe('removePreferenceEntry', () => {
  it('removes by key and returns true', () => {
    appendPreferenceEntry('- [USER-TYPED] [DISMISS] "A" — reason: "b"');
    const [entry] = listPreferenceEntries();
    expect(removePreferenceEntry(entry.key)).toBe(true);
    expect(listPreferenceEntries()).toHaveLength(0);
  });

  it('returns false on unknown key', () => {
    expect(removePreferenceEntry('nope')).toBe(false);
  });
});
