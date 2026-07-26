/**
 * scan-retirement-surface.test.ts — surface-precise retirement scanning helper
 * (P-005, agent-trap-guards-2026-07-26).
 *
 * `scripts/scan-retirement-surface.mjs` exists because WI-6097's bare-substring
 * grep for a retired surface generated false positives at scale: `messages`
 * matched the live `coord:*` plane, `messages:send` matched an unrelated FCM
 * endpoint URL. This suite pins:
 *   - word-boundary-safe identifier matching (an identifier doesn't match as a
 *     substring of a longer identifier-ish token);
 *   - the allowlist mechanism actually suppresses a known false positive while
 *     leaving an un-allowlisted hit of the SAME identifier in a different file
 *     flagged;
 *   - `loadSurface` validates the config shape;
 *   - a real-tree smoke test that the shipped worked-example config
 *     (`scripts/retirement-surfaces/work-item-mail-2026-07-26.json`) runs
 *     clean against the actual repo and its FCM allowlist entry is still
 *     exercised (device-push-dispatcher.ts still contains the collision it
 *     was written to suppress).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { inferWorkspaceRoot } from '@papercusp/testing-shell/glob';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS helper script, no .d.ts; imported for its functions.
import * as scan from '../../../scripts/scan-retirement-surface.mjs';

const globToRegExp = scan.globToRegExp as (glob: string) => RegExp;
const matchesGlob = scan.matchesGlob as (glob: string, filePath: string) => boolean;
const findIdentifierHits = scan.findIdentifierHits as (text: string, identifier: string) => number[];
const loadSurface = scan.loadSurface as (path: string) => {
  name: string;
  identifiers: string[];
  allowlist: Array<{ file: string; match?: string; reason?: string }>;
  excludeGlobs: string[];
};
const scanSurface = scan.scanSurface as (opts: {
  identifiers: string[];
  allowlist?: Array<{ file: string; match?: string; reason?: string }>;
  excludeGlobs?: string[];
  root?: string;
  listFiles?: () => string[];
  readFile?: (f: string) => string;
}) => {
  hits: Array<{ file: string; line: number; identifier: string; lineText: string }>;
  suppressed: Array<{ file: string; line: number; identifier: string; lineText: string; reason: string }>;
  byIdentifier: Record<string, unknown[]>;
  filesScanned: number;
};
const DEFAULT_EXCLUDE_GLOBS = scan.DEFAULT_EXCLUDE_GLOBS as string[];

const WORKSPACE_ROOT = inferWorkspaceRoot();
const IS_GIT_REPO = existsSync(join(WORKSPACE_ROOT, '.git'));

describe('scan-retirement-surface: glob matching', () => {
  it('matches a literal path', () => {
    expect(matchesGlob('foo/bar.ts', 'foo/bar.ts')).toBe(true);
    expect(matchesGlob('foo/bar.ts', 'foo/baz.ts')).toBe(false);
  });

  it('`*` matches within a single path segment only', () => {
    expect(matchesGlob('foo/*.ts', 'foo/bar.ts')).toBe(true);
    expect(matchesGlob('foo/*.ts', 'foo/nested/bar.ts')).toBe(false);
  });

  it('`**` matches across path segments, including the root', () => {
    expect(matchesGlob('**/bar.ts', 'foo/nested/bar.ts')).toBe(true);
    expect(matchesGlob('**/bar.ts', 'bar.ts')).toBe(true);
    expect(matchesGlob('_retired/**', '_retired/x/y.ts')).toBe(true);
    expect(matchesGlob('_retired/**', 'not-retired/x.ts')).toBe(false);
  });

  it('escapes regex-special characters in the literal parts', () => {
    const re = globToRegExp('a.b+c');
    expect(re.test('a.b+c')).toBe(true);
    expect(re.test('aXb+c')).toBe(false); // '.' must be literal, not "any char"
  });
});

describe('scan-retirement-surface: word-boundary identifier matching', () => {
  it('matches a bare identifier occurrence', () => {
    expect(findIdentifierHits("call('messages:send')", 'messages:send')).toEqual([6]);
  });

  it('does NOT match as a substring of a longer identifier-ish token', () => {
    // "messages:sender" contains "messages:send" but is flanked by a word char ('e').
    expect(findIdentifierHits('const x = messages:sender;', 'messages:send')).toEqual([]);
  });

  it('DOES match when flanked only by non-identifier characters (quotes, colons, punctuation)', () => {
    // This is precisely the WI-6097 trap: a fully-qualified identifier still
    // matches an unrelated string that happens to contain it verbatim — the
    // boundary check alone cannot rule this out, which is why the allowlist exists.
    const text = '`https://fcm.googleapis.com/.../messages:send`';
    expect(findIdentifierHits(text, 'messages:send')).toEqual([text.indexOf('messages:send')]);
  });

  it('finds multiple occurrences in one text', () => {
    const hits = findIdentifierHits('op:send_message\nop:send_message', 'send_message');
    expect(hits.length).toBe(2);
  });
});

describe('scan-retirement-surface: loadSurface', () => {
  const tmpFiles: string[] = [];
  afterEach(() => {
    for (const f of tmpFiles.splice(0)) rmSync(f, { force: true });
  });

  function writeTmpConfig(obj: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'scan-retirement-surface-test-'));
    const path = join(dir, 'surface.json');
    writeFileSync(path, JSON.stringify(obj));
    tmpFiles.push(path);
    return path;
  }

  it('loads a valid config and merges excludeGlobs onto the defaults', () => {
    const path = writeTmpConfig({
      name: 'demo',
      identifiers: ['foo:bar'],
      allowlist: [{ file: '**/x.ts', reason: 'demo' }],
      excludeGlobs: ['extra/**'],
    });
    const surface = loadSurface(path);
    expect(surface.name).toBe('demo');
    expect(surface.identifiers).toEqual(['foo:bar']);
    expect(surface.excludeGlobs).toEqual([...DEFAULT_EXCLUDE_GLOBS, 'extra/**']);
  });

  it('rejects a config with no identifiers', () => {
    const path = writeTmpConfig({ name: 'empty', identifiers: [] });
    expect(() => loadSurface(path)).toThrow(/identifiers/);
  });
});

describe('scan-retirement-surface: scanSurface (injected fixture tree)', () => {
  const files: Record<string, string> = {
    'live/coord-plane.ts': "// unrelated: coord/messages.ts, coord_event_log — shares the word, not the identifier",
    'live/fcm-dispatcher.ts': "const url = `https://fcm.googleapis.com/v1/.../messages:send`;",
    'live/panel.tsx': "dispatch({ op: 'messages:send' });",
    'live/other-panel.tsx': "dispatch({ op: 'messages:dismiss' });",
  };

  function fixtureScan(overrides: Partial<Parameters<typeof scanSurface>[0]> = {}) {
    return scanSurface({
      identifiers: ['messages:send', 'messages:dismiss'],
      allowlist: [{ file: 'live/fcm-dispatcher.ts', match: 'messages:send', reason: 'FCM endpoint, not our tool' }],
      root: '/fixture',
      listFiles: () => Object.keys(files),
      readFile: (f: string) => files[f],
      ...overrides,
    });
  }

  it('flags a genuine hit and suppresses the allowlisted false positive of the SAME identifier', () => {
    const { hits, suppressed } = fixtureScan({ identifiers: ['messages:send'] });
    expect(hits).toEqual([
      { file: 'live/panel.tsx', line: 1, identifier: 'messages:send', lineText: "dispatch({ op: 'messages:send' });" },
    ]);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].file).toBe('live/fcm-dispatcher.ts');
    expect(suppressed[0].reason).toBe('FCM endpoint, not our tool');
  });

  it('flags an identifier with no matching allowlist entry', () => {
    const { hits } = fixtureScan();
    const dismissHits = hits.filter((h) => h.identifier === 'messages:dismiss');
    expect(dismissHits).toEqual([
      { file: 'live/other-panel.tsx', line: 1, identifier: 'messages:dismiss', lineText: "dispatch({ op: 'messages:dismiss' });" },
    ]);
  });

  it('a bare-word comment mentioning "messages" is never flagged — identifiers are exact, not substrings of English words', () => {
    const { hits, suppressed } = fixtureScan();
    const coordFileHits = [...hits, ...suppressed].filter((h) => h.file === 'live/coord-plane.ts');
    expect(coordFileHits).toEqual([]);
  });

  it('groups hits by identifier and reports filesScanned', () => {
    const { byIdentifier, filesScanned } = fixtureScan({ identifiers: ['messages:send'] });
    expect(filesScanned).toBe(Object.keys(files).length);
    expect(Object.keys(byIdentifier)).toEqual(['messages:send']);
  });

  it('excludeGlobs drops a file from the scan entirely, even one containing a genuine hit', () => {
    const { hits } = fixtureScan({ excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS, 'live/panel.tsx'] });
    expect(hits.find((h) => h.file === 'live/panel.tsx')).toBeUndefined();
  });
});

describe.skipIf(!IS_GIT_REPO)('scan-retirement-surface: real-tree smoke test (worked example)', () => {
  it('the shipped work-item-mail worked example scans the real tree and still exercises its FCM allowlist entry', () => {
    const configPath = join(WORKSPACE_ROOT, 'scripts/retirement-surfaces/work-item-mail-2026-07-26.json');
    const surface = loadSurface(configPath);
    const result = scanSurface({ ...surface, root: WORKSPACE_ROOT });

    expect(result.filesScanned).toBeGreaterThan(1000);
    // The FCM-endpoint false positive this config was written to demonstrate
    // must still exist and still be suppressed — if this ever goes to zero,
    // either device-push-dispatcher.ts changed (update the fixture) or the
    // allowlist regressed (a real bug).
    expect(
      result.suppressed.some(
        (s) => s.file.endsWith('device-push-dispatcher.ts') && s.identifier === 'messages:send',
      ),
    ).toBe(true);
  });
});
