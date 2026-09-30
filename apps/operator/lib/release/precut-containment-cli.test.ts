import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitProbe } from '@papercusp/operator-core/lib/release/judged-sha-containment';
import { judgePrecutSet, renderReport, type PrecutDeps, type PrecutSet } from './precut-containment-cli';

// Blobs per ref, keyed by superproject-relative path. The fake exposes no submodule
// methods, so containmentForPaths falls back to blobAt, which is all this layer needs.
function fakeDeps(opts: {
  main: Record<string, string>;
  staging: Record<string, string>;
  content?: Record<string, string>;
  dirty?: string[];
  refs?: Record<string, string | null>;
}): PrecutDeps {
  const refs = opts.refs ?? { main: 'm'.repeat(40), staging: 's'.repeat(40) };
  const byRef: Record<string, Record<string, string>> = {
    [refs.main ?? '']: opts.main,
    [refs.staging ?? '']: opts.staging,
  };
  const git: GitProbe = {
    revParse: (_root, ref) => (ref in refs ? refs[ref] : null),
    isAncestor: () => null,
    blobAt: (_root, ref, path) => byRef[ref]?.[path] ?? null,
  };
  return {
    git,
    isDirty: (_root, path) => (opts.dirty ?? []).includes(path),
    readAt: (_root, _ref, path) => opts.content?.[path] ?? null,
  };
}

const set: PrecutSet = {
  release: '9.9.9',
  items: [
    { id: 'A', label: 'contained', paths: [{ path: 'a.ts', marker: 'FIX_A' }] },
    { id: 'B', label: 'staged only', paths: ['b.ts'] },
    { id: 'C', label: 'uncommitted', paths: ['c.ts'] },
    { id: 'D', label: 'marker gone', paths: [{ path: 'd.ts', marker: 'FIX_D' }] },
    { id: 'E', label: 'absent', paths: ['e.ts'] },
    { id: 'F', label: 'not defined yet', paths: [], note: 'owner to add paths' },
  ],
};

describe('judgePrecutSet (WI-10002524 pre-cut go/no-go)', () => {
  const deps = fakeDeps({
    main: { 'a.ts': '1', 'b.ts': 'old', 'c.ts': '3', 'd.ts': '4' },
    staging: { 'a.ts': '1', 'b.ts': 'new', 'c.ts': '3', 'd.ts': '4' },
    content: { 'a.ts': 'x FIX_A y', 'd.ts': 'reverted' },
    dirty: ['c.ts'],
  });
  const report = judgePrecutSet(set, '/repo', 'main', deps, 'staging');
  const verdict = (id: string) => report.items.find((i) => i.id === id)?.verdict;

  it('classifies every path shape', () => {
    expect(verdict('A')).toBe('IN-MAIN');
    expect(verdict('B')).toBe('STAGED-NOT-IN-MAIN');
    expect(verdict('E')).toBe('ABSENT');
    expect(verdict('F')).toBe('PENDING');
  });

  it('reads a new file that exists only in the working tree as UNCOMMITTED, not ABSENT', () => {
    const untracked = fakeDeps({ main: {}, staging: {}, dirty: ['new.ts'] });
    const r = judgePrecutSet(
      { release: '9.9.9', items: [{ id: 'N', label: 'new file', paths: ['new.ts'] }] },
      '/repo',
      'main',
      untracked,
      'staging',
    );
    expect(r.items[0].verdict).toBe('UNCOMMITTED');
  });

  it('never reads an uncommitted fix as contained, even with equal main/staging blobs', () => {
    // c.ts has identical blobs on main and staging. Only the dirty check stops this
    // from reading IN-MAIN while the fix exists solely in the working tree.
    expect(verdict('C')).toBe('UNCOMMITTED');
  });

  it('requires the declared marker in main content, not just blob equality', () => {
    expect(verdict('D')).toBe('MARKER-MISSING');
  });

  it('is GO only when every item is IN-MAIN; a pending item alone blocks it', () => {
    expect(report.go).toBe(false);
    const onlyA = judgePrecutSet({ release: '9.9.9', items: [set.items[0]] }, '/repo', 'main', deps, 'staging');
    expect(onlyA.go).toBe(true);
    const withPending = judgePrecutSet(
      { release: '9.9.9', items: [set.items[0], set.items[5]] },
      '/repo',
      'main',
      deps,
      'staging',
    );
    expect(withPending.go).toBe(false);
  });

  it('an item takes its worst path verdict', () => {
    const mixed = judgePrecutSet(
      { release: '9.9.9', items: [{ id: 'M', label: 'mixed', paths: ['a.ts', 'b.ts', 'c.ts'] }] },
      '/repo',
      'main',
      deps,
      'staging',
    );
    expect(mixed.items[0].verdict).toBe('UNCOMMITTED');
  });

  it('refuses rather than guesses when a ref does not resolve', () => {
    const noMain = fakeDeps({ main: {}, staging: {}, refs: { main: null, staging: 's'.repeat(40) } });
    expect(() => judgePrecutSet(set, '/repo', 'main', noMain, 'staging')).toThrow(/cannot resolve main/);
  });

  it('renders the verdict line and names each failing path', () => {
    const text = renderReport(report);
    expect(text).toContain('pre-cut containment for 9.9.9: NO-GO');
    expect(text).toMatch(/UNCOMMITTED\s+c\.ts/);
    expect(text).not.toMatch(/IN-MAIN\s+a\.ts/);
  });
});

describe('precut-sets/0.0.26.json', () => {
  it('parses and every declared path entry is well-formed', () => {
    const parsed = JSON.parse(readFileSync(resolve(__dirname, 'precut-sets/0.0.26.json'), 'utf8')) as PrecutSet;
    expect(parsed.release).toBe('0.0.26');
    for (const item of parsed.items) {
      expect(item.id).toBeTruthy();
      for (const p of item.paths) {
        const path = typeof p === 'string' ? p : p.path;
        expect(path).not.toMatch(/^\/|\.\./);
      }
      if (item.paths.length === 0) expect(item.note, `${item.id} is pending without a note`).toBeTruthy();
    }
  });
});
