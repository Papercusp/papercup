/**
 * Pure/non-firing coverage for D-026 run provenance. No scenario or mesh is
 * started here; filesystem checks operate only inside a fresh temp directory.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostLoadEvidence, PerfArtifact, RunProvenance } from './artifact';
import {
  diffSubjectDrift,
  captureRunProvenance,
  finalizeArtifactProvenance,
  parsePorcelainStatus,
  parseSubmoduleStatus,
  selectPathsInScope,
  stampArtifactProvenance,
  stampSubjectTree,
} from './provenance';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('run-start capture', () => {
  it('captures last-commit, scoped dirtiness, complete mtimes, and explicit pre-final host state', () => {
    const root = tempRoot();
    const scope = 'subject';
    mkdirSync(join(root, scope));
    const source = join(root, scope, 'source.ts');
    writeFileSync(source, 'committed');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'p2p provenance test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'p2p-provenance@example.invalid'], { cwd: root });
    execFileSync('git', ['add', scope], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root });
    writeFileSync(source, 'dirty');

    const captured = captureRunProvenance({
      from: join(root, scope),
      scope: [scope],
      hostAtStart: {
        loadavg1m: 1,
        cpus: 8,
        ratio1m: 0.125,
        psiMemSome60: null,
        psiCpuSome60: null,
        swapPagesAtStart: null,
      },
    });

    expect(captured.lastCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(captured.subjectLastCommitSha).toBe(captured.lastCommitSha);
    expect(captured.worktree?.dirtyFileCount).toBe(1);
    expect(captured.worktree?.dirtyPathsInScope).toEqual([`${scope}/source.ts`]);
    expect(captured.subjects?.[0]).toMatchObject({
      dir: scope,
      fileCount: 1,
      newestPath: `${scope}/source.ts`,
    });
    expect(captured.subjects?.[0]?.mtimesDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(captured.hostLoad).toBeNull();
    expect(captured.unavailable).toEqual([]);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'p2p-provenance-'));
  tempRoots.push(root);
  return root;
}

const hostLoad: HostLoadEvidence = {
  loadavg1m: 80,
  cpus: 128,
  ratio1m: 0.75,
  oversubscribed: false,
  swapPagesDelta: 321,
  memoryContended: false,
  memoryContendedReason: null,
  psiMemSome60: 1.25,
  psiCpuSome60: 3.5,
};

function artifact(provenance: RunProvenance | null = null): PerfArtifact {
  return {
    schema: 2,
    provenance,
    scenario: 'merge.idle-tick',
    tier: 1,
    params: { peers: 4 },
    startedAt: '2026-08-29T00:00:00.000Z',
    durationMs: 10,
    host: { hostname: 'host-deadbeef', platform: 'linux', arch: 'x64', cpus: 128, node: 'v22' },
    metrics: {},
    loopLag: null,
    sloPassed: null,
    sloLimitMs: 100,
    convergence: null,
    convergencePassed: null,
    cpu: { userMs: 1, systemMs: 1 },
    rss: { peakBytes: 1 },
    notes: [],
  };
}

function runProvenance(root: string, scope: string): RunProvenance {
  return {
    capturedAt: '2026-08-29T00:00:00.000Z',
    lastCommitSha: 'a'.repeat(40),
    lastCommitAt: '2026-08-28T00:00:00.000Z',
    subjectLastCommitSha: 'b'.repeat(40),
    subjectLastCommitAt: '2026-08-28T01:00:00.000Z',
    submodulesDivergedFromGitlink: [],
    worktree: {
      dirtyDigest: '0123456789abcdef',
      dirtyFileCount: 1,
      dirtyPathsInScope: [`${scope}/older.ts`],
      scopedTruncated: false,
      scope: [scope],
    },
    subjects: [stampSubjectTree(root, scope)],
    subjectDriftSinceCapture: null,
    hostAtStart: {
      loadavg1m: 64,
      cpus: 128,
      ratio1m: 0.5,
      psiMemSome60: 1,
      psiCpuSome60: 2,
      swapPagesAtStart: 100,
    },
    hostLoad: null,
    unavailable: [],
  };
}

describe('pure git-output parsing', () => {
  it('labels only non-space submodule status rows as diverged', () => {
    expect(
      parseSubmoduleStatus(
        ` aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa libs/in-sync (heads/main)\n+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb libs/ahead (heads/main)\n-cccccccccccccccccccccccccccccccccccccccc libs/missing`,
      ),
    ).toEqual([
      {
        status: ' ',
        sha: 'a'.repeat(40),
        path: 'libs/in-sync',
        diverged: false,
      },
      {
        status: '+',
        sha: 'b'.repeat(40),
        path: 'libs/ahead',
        diverged: true,
      },
      {
        status: '-',
        sha: 'c'.repeat(40),
        path: 'libs/missing',
        diverged: true,
      },
    ]);
  });

  it('fingerprints porcelain output and keeps the destination of a rename', () => {
    const parsed = parsePorcelainStatus(
      [' M packages/operator-core/a.ts', 'R  old.ts -> packages/operator-core/new.ts', '?? docs/note.md'].join('\n'),
    );
    expect(parsed.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.fileCount).toBe(3);
    expect(parsed.paths).toEqual(['packages/operator-core/a.ts', 'packages/operator-core/new.ts', 'docs/note.md']);
    expect(selectPathsInScope(parsed.paths, ['packages/operator-core'])).toEqual([
      'packages/operator-core/a.ts',
      'packages/operator-core/new.ts',
    ]);
  });
});

describe('subject-tree mtime inventory', () => {
  it('detects a write to an older file even when the newest file and newest mtime do not change', () => {
    const root = tempRoot();
    const scope = 'subject';
    mkdirSync(join(root, scope));
    const older = join(root, scope, 'older.ts');
    const newest = join(root, scope, 'newest.ts');
    const base = Date.now() - 120_000;
    writeFileSync(older, 'before');
    writeFileSync(newest, 'newest');
    utimesSync(older, new Date(base), new Date(base));
    utimesSync(newest, new Date(base + 60_000), new Date(base + 60_000));

    const before = stampSubjectTree(root, scope);
    writeFileSync(older, 'after');
    // Still older than newest.ts: a max-only stamp would miss this change.
    utimesSync(older, new Date(base + 30_000), new Date(base + 30_000));
    const after = stampSubjectTree(root, scope);

    expect(after.newestPath).toBe(before.newestPath);
    expect(after.newestMtimeMs).toBe(before.newestMtimeMs);
    expect(after.mtimesDigest).not.toBe(before.mtimesDigest);
    expect(diffSubjectDrift([before], [after])).toEqual([scope]);
  });

  it('returns unknown rather than clearing drift when either inventory is incomplete', () => {
    const root = tempRoot();
    const missing = stampSubjectTree(root, 'does-not-exist');
    expect(missing.mtimesDigest).toBeNull();
    expect(diffSubjectDrift([missing], [missing])).toBeNull();
    expect(diffSubjectDrift(null, [missing])).toBeNull();
  });
});

describe('artifact stamping and finalization', () => {
  it('stamps per-artifact drift and then carries the runner final host evidence without mutating inputs', () => {
    const root = tempRoot();
    const scope = 'subject';
    mkdirSync(join(root, scope));
    const source = join(root, scope, 'source.ts');
    writeFileSync(source, 'before');
    const base = Date.now() - 10_000;
    utimesSync(source, new Date(base), new Date(base));

    const captured = runProvenance(root, scope);
    const incoming = artifact();
    writeFileSync(source, 'after');
    utimesSync(source, new Date(base + 5_000), new Date(base + 5_000));
    const stamped = stampArtifactProvenance(incoming, captured, root);

    expect(incoming.provenance).toBeNull();
    expect(stamped.provenance?.subjectDriftSinceCapture).toEqual([scope]);
    expect(stamped.provenance?.hostLoad).toBeNull();

    const finalized = finalizeArtifactProvenance(stamped, hostLoad);
    expect(stamped.provenance?.hostLoad).toBeNull();
    expect(finalized.provenance?.hostLoad).toEqual(hostLoad);
    expect(finalized).not.toBe(stamped);
    expect(finalized.provenance).not.toBe(stamped.provenance);
  });

  it('does not fabricate code provenance solely to attach host evidence', () => {
    const incoming = artifact(null);
    expect(finalizeArtifactProvenance(incoming, hostLoad)).toBe(incoming);
  });
});
