/**
 * Pure-parsing coverage for operator-preferences.ts.
 *
 * Targets ONLY the pure, PG-free subset:
 *   - parseStandingApprovals  (the APPROVAL_RE extraction)
 *   - listPreferenceEntries   (## YYYY-MM-DD section split, tag extraction,
 *                              sub-bullet folding) — exercised via a mocked
 *                              readOperatorState so no live PG is touched
 *   - hashEntry stability     (asserted indirectly through the `key` field
 *                              of listPreferenceEntries entries, since
 *                              hashEntry itself is not exported)
 *
 * loadPreferences/appendPreferenceEntry/removePreferenceEntry (which need
 * operator-state-pg writes) are deliberately NOT covered here.
 *
 * parseStandingApprovals is a pure exported function (string -> []) and is
 * tested directly. listPreferenceEntries reads markdown via
 * `readOperatorState('operator_preferences')`; we mock `./operator-state-pg`
 * to feed it a fixed markdown body, which is the smallest exported surface
 * that exercises the section-split + tag + sub-bullet + hash logic.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// readOperatorState is the only thing listPreferenceEntries calls into PG
// for. Mock it to return a controllable `{ content }` payload. writeOperatorState
// is stubbed too (module import-time references it) but is never invoked by the
// pure read paths under test.
let mockContent: string | undefined = '';
vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => ({ content: mockContent })),
  writeOperatorState: vi.fn(async () => {}),
}));

import {
  parseStandingApprovals,
  listPreferenceEntries,
  type StandingApproval,
} from './operator-preferences';

beforeEach(() => {
  mockContent = '';
});

describe('parseStandingApprovals (APPROVAL_RE extraction)', () => {
  it('extracts capability, target, and confirmedAt date from a single-line approval', () => {
    const md =
      '- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-06-04] [STANDING-APPROVE] capability=deploy, target=my-app';
    const out = parseStandingApprovals(md);
    expect(out).toEqual<StandingApproval[]>([
      { confirmedAt: '2026-06-04', capability: 'deploy', targetHarness: 'my-app' },
    ]);
  });

  it('extracts multiple approvals across the document', () => {
    const md = [
      '## 2026-06-01',
      '- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-06-01] [STANDING-APPROVE] capability=cap-a, target=harness-one',
      '## 2026-06-02',
      '- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-06-02] [STANDING-APPROVE] capability=cap-b, target=harness-two',
    ].join('\n');
    const out = parseStandingApprovals(md);
    expect(out).toEqual<StandingApproval[]>([
      { confirmedAt: '2026-06-01', capability: 'cap-a', targetHarness: 'harness-one' },
      { confirmedAt: '2026-06-02', capability: 'cap-b', targetHarness: 'harness-two' },
    ]);
  });

  it('matches across whitespace/newlines between the tags and the fields', () => {
    // APPROVAL_RE uses [\s\S]*? between segments, so a wrapped entry still matches.
    const md =
      '- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-05-30] [STANDING-APPROVE]\n  capability=publish,\n  target=site-x';
    const out = parseStandingApprovals(md);
    expect(out).toEqual<StandingApproval[]>([
      { confirmedAt: '2026-05-30', capability: 'publish', targetHarness: 'site-x' },
    ]);
  });

  it('capability/target stop at the field delimiters (comma / whitespace)', () => {
    // capability=([^\s,]+) stops at the comma; target=([^\s\n]+) stops at whitespace.
    const md =
      '- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-06-04] [STANDING-APPROVE] capability=foo, target=bar baz';
    const out = parseStandingApprovals(md);
    expect(out[0]).toEqual({ confirmedAt: '2026-06-04', capability: 'foo', targetHarness: 'bar' });
  });

  it('requires the STANDING-APPROVE tag — a plain confirmed entry is not an approval', () => {
    const md =
      '- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-06-04] capability=deploy, target=my-app';
    expect(parseStandingApprovals(md)).toEqual([]);
  });

  it('returns [] for empty / approval-free markdown', () => {
    expect(parseStandingApprovals('')).toEqual([]);
    expect(parseStandingApprovals('## 2026-06-04\n- [USER-TYPED] some note')).toEqual([]);
  });
});

describe('listPreferenceEntries — section split / tags / sub-bullet folding', () => {
  it('returns [] when the stored markdown is empty', async () => {
    mockContent = '';
    expect(await listPreferenceEntries()).toEqual([]);
  });

  it('returns [] when the stored payload has no content string', async () => {
    mockContent = undefined;
    expect(await listPreferenceEntries()).toEqual([]);
  });

  it('splits on `## YYYY-MM-DD` headers and assigns the date to each entry', async () => {
    mockContent = ['## 2026-06-01', '- first note', '', '## 2026-06-02', '- second note'].join('\n');
    const entries = await listPreferenceEntries();
    expect(entries.map((e) => ({ date: e.date, body: e.body }))).toEqual([
      { date: '2026-06-01', body: '- first note' },
      { date: '2026-06-02', body: '- second note' },
    ]);
  });

  it('treats each top-level `- ` bullet as a separate entry within a section', async () => {
    mockContent = ['## 2026-06-03', '- alpha', '- beta', '- gamma'].join('\n');
    const entries = await listPreferenceEntries();
    expect(entries.map((e) => e.body)).toEqual(['- alpha', '- beta', '- gamma']);
    expect(entries.every((e) => e.date === '2026-06-03')).toBe(true);
  });

  it('folds sub-bullets / continuation lines into the parent entry body', async () => {
    mockContent = [
      '## 2026-06-04',
      '- parent bullet',
      '  - child sub-bullet',
      '  continuation text',
      '- next top-level bullet',
    ].join('\n');
    const entries = await listPreferenceEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].body).toBe('- parent bullet\n  - child sub-bullet\n  continuation text');
    expect(entries[1].body).toBe('- next top-level bullet');
  });

  it('drops leading lines that precede the first top-level bullet in a section', async () => {
    // Lines before the first `- ` bullet are not folded into anything (cur is empty).
    mockContent = ['## 2026-06-04', 'preamble that is not a bullet', '- real entry'].join('\n');
    const entries = await listPreferenceEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe('- real entry');
  });

  it('extracts provenance/kind tags from the entry body', async () => {
    mockContent = [
      '## 2026-06-04',
      '- [USER-TYPED] [DISMISS] avoid noisy notifications',
      '- [OPERATOR-PROPOSED-USER-CONFIRMED-2026-06-04] [STANDING-APPROVE] capability=deploy, target=x',
    ].join('\n');
    const entries = await listPreferenceEntries();
    expect(entries[0].tags).toEqual(['USER-TYPED', 'DISMISS']);
    expect(entries[1].tags).toEqual(['OPERATOR-PROPOSED-USER-CONFIRMED-2026-06-04', 'STANDING-APPROVE']);
  });

  it('computes addedAt ISO from a valid date header', async () => {
    mockContent = ['## 2026-06-04', '- note'].join('\n');
    const [entry] = await listPreferenceEntries();
    expect(entry.addedAt).toBe('2026-06-04T00:00:00.000Z');
  });

  it('falls back to epoch for a non-date section header', async () => {
    mockContent = ['## not-a-date', '- note'].join('\n');
    const [entry] = await listPreferenceEntries();
    expect(entry.addedAt).toBe(new Date(0).toISOString());
  });
});

describe('hashEntry stability (observed via the entry `key` field)', () => {
  it('same date+body yields the same key across calls (deterministic)', async () => {
    mockContent = ['## 2026-06-04', '- stable entry'].join('\n');
    const a = await listPreferenceEntries();
    const b = await listPreferenceEntries();
    expect(a[0].key).toBe(b[0].key);
    expect(a[0].key).toMatch(/^[0-9a-z]+$/); // base36
  });

  it('different bodies under the same date yield different keys', async () => {
    mockContent = ['## 2026-06-04', '- entry one', '- entry two'].join('\n');
    const [e1, e2] = await listPreferenceEntries();
    expect(e1.key).not.toBe(e2.key);
  });

  it('the same body under a different date yields a different key', async () => {
    mockContent = ['## 2026-06-04', '- same body'].join('\n');
    const dayOne = (await listPreferenceEntries())[0].key;
    mockContent = ['## 2026-06-05', '- same body'].join('\n');
    const dayTwo = (await listPreferenceEntries())[0].key;
    expect(dayOne).not.toBe(dayTwo);
  });
});
