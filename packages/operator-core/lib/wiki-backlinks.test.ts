/**
 * wiki-backlinks.test.ts — the [[target]] backlink scanner (the single impl
 * behind both /api/wiki-backlinks and the wiki:backlinks MCP tool).
 *
 * Exercises the link-parsing core (findReferences, module-private) through the
 * public findWikiBacklinks: plain [[target]], the harness-qualified
 * [[harness/target]] + its hint filter, the [[target|alias]] alias form, `.md`
 * normalization, and the no-`[[` fast-skip. The harness registry is mocked; the
 * markdown lives in a real temp dir (no PG, deterministic).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loadHarnessRegistryMock = vi.fn();
vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: () => loadHarnessRegistryMock(),
}));

import { findWikiBacklinks } from './wiki-backlinks';

let projectDir: string;

const NOTES = [
  'Link to [[target]] here.', //          line 1: plain — always matches
  'Also [[h2/target]] qualified.', //     line 2: h2-qualified — filtered when hint=h1
  'And [[target|an alias]].', //          line 3: alias form — matches target
  '[[h1/target]] same harness.', //       line 4: h1-qualified — matches when hint=h1 or null
  '[[other]] no match.', //               line 5: different target — no hit
  'A line with [[ but no close.', //      line 6: malformed — no hit
].join('\n');

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'wiki-bl-'));
  writeFileSync(join(projectDir, 'notes.md'), NOTES, 'utf8');
  mkdirSync(join(projectDir, '.papercusp'), { recursive: true });
  writeFileSync(join(projectDir, '.papercusp', 'spec.md'), 'A ref [[target.md]] with suffix.\n', 'utf8');
  // A file with no wiki link at all — must be fast-skipped, never a hit.
  writeFileSync(join(projectDir, 'plain.md'), 'no links here at all\n', 'utf8');
  loadHarnessRegistryMock.mockResolvedValue({ projects: [{ slug: 'h1', path: projectDir }] });
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('findWikiBacklinks', () => {
  it('finds plain, alias, .md-normalized, and qualified links (no hint → no harness filter)', async () => {
    const res = await findWikiBacklinks('target', null);
    expect(res.target).toBe('target');
    expect(res.harness).toBeNull();
    // notes.md lines 1,2,3,4 + spec.md = 5 hits.
    expect(res.hits).toHaveLength(5);
    const notesLines = res.hits.filter((h) => h.filename === 'notes.md').map((h) => h.line).sort();
    expect(notesLines).toEqual([1, 2, 3, 4]);
    // Every hit attributes the harness it was found in + a trimmed snippet.
    expect(res.hits.every((h) => h.harness === 'h1')).toBe(true);
    expect(res.hits.find((h) => h.filename === 'notes.md' && h.line === 1)?.snippet).toBe('Link to [[target]] here.');
    // The .papercusp/ file is reported with its dir-qualified relative path.
    expect(res.hits.some((h) => h.filename === '.papercusp/spec.md')).toBe(true);
  });

  it('applies the harness hint — a [[h2/target]] link is filtered out when searching harness h1', async () => {
    const res = await findWikiBacklinks('target', 'h1');
    expect(res.harness).toBe('h1');
    // line 2 ([[h2/target]]) is filtered; lines 1,3,4 + spec.md remain = 4.
    expect(res.hits).toHaveLength(4);
    expect(res.hits.some((h) => h.filename === 'notes.md' && h.line === 2)).toBe(false);
  });

  it('returns zero hits for a target that is not referenced', async () => {
    const res = await findWikiBacklinks('nonexistent-target', null);
    expect(res.hits).toEqual([]);
  });
});
