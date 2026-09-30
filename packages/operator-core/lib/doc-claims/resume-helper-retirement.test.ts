/**
 * D-001's selective resume-helper retirement is a cross-tree contract:
 * `reactivateAdvSession(id)` must stay gone from production, while the distinct
 * owner-keyed genuine-activity repair must remain live. A source-only assertion
 * cannot catch a new import/call elsewhere, so this guard walks the production
 * index and carries fixture controls proving the detector can fail.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './gate-candidate-ref';
import { presentOnDisk } from '../../../../scripts/lib/tracked-files.mjs';

// lib/doc-claims -> lib -> operator-core -> packages -> repo root
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SOURCE_ROOTS = ['apps', 'packages', 'libs', 'scripts'];
const SOURCE_FILE = /\.(?:tsx?|jsx?|[cm]js)$/;
const TEST_OR_FIXTURE_PATH =
  /(?:^|\/)(?:__tests__|tests?|fixtures?|__fixtures__|_retired)(?:\/|$)|\.(?:test|spec)\.(?:tsx?|jsx?|[cm]js)$/;
const NUMERIC_HELPER = /\breactivateAdvSession\b/;
const OWNER_HELPER = /\breactivateAdvSessionByOwner\b/;

interface SourceEntry {
  path: string;
  source: string;
}

interface ReferenceSite {
  path: string;
  line: number;
  text: string;
}

function trackedProductionSources(): SourceEntry[] {
  const files = execFileSync('git', ['ls-files', '--', ...SOURCE_ROOTS], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    killSignal: 'SIGKILL',
  })
    .split('\n')
    .filter((path) => SOURCE_FILE.test(path) && !TEST_OR_FIXTURE_PATH.test(path));

  if (files.length < 1_000 || !files.includes('packages/operator-core/lib/adv-sessions.ts')) {
    throw new Error(
      `resume-helper retirement guard resolved only ${files.length} production sources or lost adv-sessions.ts; ` +
        'refusing to report a clean zero-match result over an incomplete index',
    );
  }
  // The index keeps listing an rm'd path until git-sync commits the deletion;
  // reading it would throw ENOENT on the shared tree (WI-10004173).
  return presentOnDisk(files, ROOT).map((path) => ({ path, source: readFileSync(join(ROOT, path), 'utf8') }));
}

function findSites(entries: SourceEntry[], pattern: RegExp): ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  for (const entry of entries) {
    stripComments(entry.source).forEach((line, index) => {
      if (pattern.test(line)) sites.push({ path: entry.path, line: index + 1, text: line.trim() });
    });
  }
  return sites;
}

describe('resume-helper retirement detector controls', () => {
  it('catches the retired numeric export/import/call forms', () => {
    const fixture: SourceEntry[] = [
      {
        path: 'packages/example.ts',
        source:
          'export async function reactivateAdvSession(id: number) {}\n' +
          "import { reactivateAdvSession } from './adv-sessions';\n" +
          'await reactivateAdvSession(7);\n',
      },
    ];
    expect(findSites(fixture, NUMERIC_HELPER)).toHaveLength(3);
  });

  it('does not confuse the retained owner-keyed sibling or comments with the numeric helper', () => {
    const fixture: SourceEntry[] = [
      {
        path: 'packages/example.ts',
        source:
          '// reactivateAdvSession(7) is retired\n' +
          'export async function reactivateAdvSessionByOwner(owner: string) {}\n',
      },
    ];
    expect(findSites(fixture, NUMERIC_HELPER)).toEqual([]);
    expect(findSites(fixture, OWNER_HELPER)).toHaveLength(1);
  });
});

describe('D-001 selective resume-helper retirement holds across production', () => {
  const sources = trackedProductionSources();

  it('has a non-vacuous production corpus and positive owner-helper controls', () => {
    expect(sources.length).toBeGreaterThanOrEqual(1_000);
    const ownerPaths = new Set(findSites(sources, OWNER_HELPER).map((site) => site.path));
    expect([...ownerPaths]).toEqual(
      expect.arrayContaining([
        'packages/operator-core/lib/adv-sessions.ts',
        'packages/operator-core/lib/agent-tools/coordination/presence.ts',
        'packages/operator-core/lib/agent-tools/coordination/dispatch-heartbeat.ts',
      ]),
    );
  });

  it('contains no production export, import, or call of the retired numeric helper', () => {
    const sites = findSites(sources, NUMERIC_HELPER);
    expect(sites.map((site) => `${site.path}:${site.line} ${site.text}`)).toEqual([]);
  });
});
