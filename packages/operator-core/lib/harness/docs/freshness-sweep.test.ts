import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anchorMatchesChanged,
  classifyDrift,
  sweepHarnessDocs,
  baselineFor,
  type DocStore,
} from './freshness-sweep';
import type { GitRunner } from './subject-ref';
import type { HarnessDocRecord, DocStatus } from './doc-record';

const runGit: GitRunner = (args, cwd) => {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return Promise.resolve({ code: 0, stdout, stderr: '' });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return Promise.resolve({ code: err.status ?? -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') });
  }
};

describe('anchorMatchesChanged', () => {
  it('matches a glob anchor', () => {
    expect(anchorMatchesChanged(['src/**'], ['src/a/b.ts'])).toBe(true);
    expect(anchorMatchesChanged(['src/**'], ['lib/x.ts'])).toBe(false);
  });
  it('matches an exact file anchor', () => {
    expect(anchorMatchesChanged(['src/a.ts'], ['src/a.ts'])).toBe(true);
  });
  it('matches a directory anchor against files under it', () => {
    expect(anchorMatchesChanged(['src/dir'], ['src/dir/x.ts'])).toBe(true);
  });
  it('no match on empty inputs', () => {
    expect(anchorMatchesChanged([], ['x'])).toBe(false);
    expect(anchorMatchesChanged(['x'], [])).toBe(false);
  });
});

describe('classifyDrift (pure)', () => {
  const gen = { source: 'generated' as const, subjectRef: [{ kind: 'path' as const, globs: ['x'] }] };
  const man = { source: 'manual' as const, subjectRef: [{ kind: 'path' as const, globs: ['x'] }] };
  it('untracked when no subject ref', () => {
    expect(classifyDrift({ source: 'manual', subjectRef: [] }, { stale: false, changedPaths: [], method: 'none' }).status).toBe('untracked');
  });
  it('no-baseline → review', () => {
    expect(classifyDrift(man, { stale: false, changedPaths: [], method: 'none', error: 'no-baseline' }).status).toBe('review');
  });
  it('git error → unknown', () => {
    expect(classifyDrift(gen, { stale: false, changedPaths: [], method: 'path', error: 'git-error: boom' }).status).toBe('unknown');
  });
  it('stale generated → stale; stale manual → review', () => {
    expect(classifyDrift(gen, { stale: true, changedPaths: ['x'], method: 'path' }).status).toBe('stale');
    expect(classifyDrift(man, { stale: true, changedPaths: ['x'], method: 'path' }).status).toBe('review');
  });
  it('not stale → fresh', () => {
    expect(classifyDrift(gen, { stale: false, changedPaths: [], method: 'path' }).status).toBe('fresh');
  });
});

describe('baselineFor', () => {
  it('uses lastVerifiedSha for manual, generatedFromSha otherwise', () => {
    expect(baselineFor({ source: 'manual', lastVerifiedSha: 'v', generatedFromSha: 'g' })).toBe('v');
    expect(baselineFor({ source: 'generated', lastVerifiedSha: 'v', generatedFromSha: 'g' })).toBe('g');
    expect(baselineFor({ source: 'augmented', lastVerifiedSha: 'v', generatedFromSha: 'g' })).toBe('g');
  });
});

// ---- sweep against a real fixture repo + in-memory store ----

let repo: string;
const shas: Record<string, string> = {};
function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}
function commitAll(msg: string): string {
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'sweep-fixture-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@p.dev']);
  git(['config', 'user.name', 'T']);
  git(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/gen.ts'), 'export const g = 1;\n');
  writeFileSync(join(repo, 'src/man.ts'), 'export const m = 1;\n');
  writeFileSync(join(repo, 'src/stable.ts'), 'export const s = 1;\n');
  shas.c0 = commitAll('c0');
  writeFileSync(join(repo, 'src/gen.ts'), 'export const g = 2;\n');
  writeFileSync(join(repo, 'src/man.ts'), 'export const m = 2;\n');
  shas.c1 = commitAll('c1 touch gen + man');
});
afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

function rec(partial: Partial<HarnessDocRecord> & Pick<HarnessDocRecord, 'docId' | 'source'>): HarnessDocRecord {
  return {
    workspaceId: 'ws', harnessSlug: 'h', source: 'manual', subjectRef: [], anchorPaths: [],
    generatedFromSha: null, lastVerifiedSha: null, lastVerifiedAt: null, overlay: null,
    status: 'fresh', statusDetail: null, statusCheckedAt: null, regenEnqueuedAt: null,
    reverifyFlaggedAt: null, title: null, createdAt: '', updatedAt: '', ...partial,
  };
}

function memStore(records: HarnessDocRecord[]): DocStore & { records: HarnessDocRecord[] } {
  const byId = new Map(records.map((r) => [r.docId, r]));
  return {
    records,
    load: async () => [...byId.values()],
    setStatus: async (docId, status: DocStatus, detail) => {
      const r = byId.get(docId)!;
      r.status = status;
      r.statusDetail = detail;
    },
    markRegen: async (docId) => { byId.get(docId)!.regenEnqueuedAt = 'now'; },
    markReverify: async (docId) => { byId.get(docId)!.reverifyFlaggedAt = 'now'; },
  };
}

describe('sweepHarnessDocs', () => {
  it('flips a generated doc to stale + enqueues regen when its path changed', async () => {
    const records = [
      rec({ docId: 'features/F-1.md', source: 'generated', subjectRef: [{ kind: 'path', globs: ['src/gen.ts'] }], anchorPaths: ['src/gen.ts'], generatedFromSha: shas.c0 }),
    ];
    const store = memStore(records);
    const regen: string[] = [];
    const r = await sweepHarnessDocs({
      harnessSlug: 'h', repoRoot: repo, runGit, changedPaths: ['src/gen.ts'], store,
      onRegenNeeded: (d) => { regen.push(d.docId); },
    });
    expect(r.flippedStale).toBe(1);
    expect(r.regenEnqueued).toEqual(['features/F-1.md']);
    expect(regen).toEqual(['features/F-1.md']);
    expect(store.records[0].status).toBe('stale');
    expect(store.records[0].regenEnqueuedAt).toBe('now');
  });

  it('flips a manual doc to review + flags re-verify; idempotent on re-run', async () => {
    const records = [
      rec({ docId: 'm.md', source: 'manual', subjectRef: [{ kind: 'path', globs: ['src/man.ts'] }], anchorPaths: ['src/man.ts'], lastVerifiedSha: shas.c0 }),
    ];
    const store = memStore(records);
    const reverify: string[] = [];
    const opts = {
      harnessSlug: 'h', repoRoot: repo, runGit, changedPaths: ['src/man.ts'], store,
      onReverifyNeeded: (d: HarnessDocRecord) => { reverify.push(d.docId); },
    };
    const r1 = await sweepHarnessDocs(opts);
    expect(r1.reverifyFlagged).toEqual(['m.md']);
    expect(store.records[0].status).toBe('review');
    // Re-run: still review, but NOT re-flagged (idempotent close-the-loop).
    const r2 = await sweepHarnessDocs(opts);
    expect(r2.reverifyFlagged).toEqual([]);
    expect(reverify).toEqual(['m.md']); // callback fired exactly once
  });

  it('skips unanchored docs and docs the changed paths did not touch', async () => {
    const records = [
      rec({ docId: 'unanchored.md', source: 'manual', subjectRef: [], anchorPaths: [] }),
      rec({ docId: 'stable.md', source: 'generated', subjectRef: [{ kind: 'path', globs: ['src/stable.ts'] }], anchorPaths: ['src/stable.ts'], generatedFromSha: shas.c0, status: 'fresh' }),
    ];
    const store = memStore(records);
    const r = await sweepHarnessDocs({ harnessSlug: 'h', repoRoot: repo, runGit, changedPaths: ['src/gen.ts'], store });
    // Neither is a candidate: unanchored skipped; stable's anchor not in changed paths.
    expect(r.candidates).toBe(0);
    expect(store.records[1].status).toBe('fresh');
  });

  it('recompute-all mode (no changedPaths) checks every anchored doc', async () => {
    const records = [
      rec({ docId: 'g.md', source: 'generated', subjectRef: [{ kind: 'path', globs: ['src/gen.ts'] }], anchorPaths: ['src/gen.ts'], generatedFromSha: shas.c0 }),
      rec({ docId: 'stable.md', source: 'generated', subjectRef: [{ kind: 'path', globs: ['src/stable.ts'] }], anchorPaths: ['src/stable.ts'], generatedFromSha: shas.c0 }),
    ];
    const store = memStore(records);
    const r = await sweepHarnessDocs({ harnessSlug: 'h', repoRoot: repo, runGit, store });
    expect(r.candidates).toBe(2);
    expect(store.records.find((x) => x.docId === 'g.md')!.status).toBe('stale');
    expect(store.records.find((x) => x.docId === 'stable.md')!.status).toBe('fresh');
  });
});
