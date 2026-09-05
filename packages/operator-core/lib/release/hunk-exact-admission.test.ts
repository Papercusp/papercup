/**
 * P-020 (D-008 layers 2–3) — hunk-exact admission source, against REAL git.
 *
 * The property under test: the synthesised source commit's blob for each path is repairHead's
 * blob + ONLY the caller's ledgered hunks, so a stranger's concurrent edit to the same file
 * on staging never enters the judged lineage — and every refusal names its explicit exit.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { admitPathsOntoRepairHead } from './repair-head-admission';
import { buildHunkExactSource, summarizeForeignHunks } from './hunk-exact-admission';
import type { FrozenRepairEditLedgerRow } from './frozen-repair-edit-ledger';

const TEMP: string[] = [];
afterEach(() => {
  for (const d of TEMP.splice(0)) rmSync(d, { recursive: true, force: true });
});
const HOME = mkdtempSync(join(tmpdir(), 'hunk-home-'));
TEMP.push(HOME);
const GIT_ENV = {
  ...process.env,
  HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.local',
};
function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000, killSignal: 'SIGKILL' }).trim();
}
function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function sweep(root: string, edits: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(edits)) write(root, rel, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg]);
  return git(root, ['rev-parse', 'HEAD']);
}
function show(root: string, ref: string, rel: string): string {
  return execFileSync('git', ['-C', root, 'show', `${ref}:${rel}`], { encoding: 'utf8', env: GIT_ENV, timeout: 30_000 });
}

const BASE_A = 'export const a = 1;\nexport const b = 2;\n';
function repo(): { root: string; candidate: string } {
  const root = mkdtempSync(join(tmpdir(), 'hunk-repo-'));
  TEMP.push(root);
  git(root, ['init', '-q', '-b', 'staging']);
  write(root, 'lib/a.ts', BASE_A);
  write(root, 'lib/b.ts', 'export const bb = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'candidate']);
  return { root, candidate: git(root, ['rev-parse', 'HEAD']) };
}

const T0 = 1_800_000_000_000;
let seq = 0;
const row = (agent: string, path: string, hunk: FrozenRepairEditLedgerRow['hunk'], atMs = T0 + seq): FrozenRepairEditLedgerRow => {
  seq += 1;
  return { id: seq, candidate: 'c'.repeat(40), agent, path, hunk, atMs, toolUseId: `t${seq}`, editIndex: 0, workItem: null };
};

describe('buildHunkExactSource — only the caller\'s hunks enter (P-020 / D-008)', () => {
  it('replays the caller\'s hunks onto repairHead\'s blob and leaves a stranger\'s concurrent edit on staging OUT of the lineage', () => {
    const { root, candidate } = repo();
    // Staging moves on: my fix (a = 10) AND a peer's unrelated edit (b = 20) land in the same file.
    sweep(root, { 'lib/a.ts': 'export const a = 10;\nexport const b = 20;\n' }, 'sweep: mine + theirs');
    const ledger = [
      row('me', 'lib/a.ts', { kind: 'edit', old: 'export const a = 1;', new: 'export const a = 10;', replaceAll: false }),
      row('peer', 'lib/a.ts', { kind: 'edit', old: 'export const b = 2;', new: 'export const b = 20;', replaceAll: false }),
    ];
    const built = buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], ledger, actor: 'me', nowMs: T0 });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.detail);
    expect(show(root, built.sourceCommit, 'lib/a.ts')).toBe('export const a = 10;\nexport const b = 2;\n');
    expect(built.perPath[0]).toMatchObject({ path: 'lib/a.ts', applied: 1, agents: ['me'], foreignHunks: 1, foreignAgents: ['peer'], unchanged: false });
    expect(git(root, ['rev-parse', `${built.sourceCommit}^`])).toBe(candidate);
    // Untouched paths are repairHead's, byte for byte.
    expect(show(root, built.sourceCommit, 'lib/b.ts')).toBe('export const bb = 1;\n');

    // And the P-001 primitive admits from it exactly as from any commit: the lineage gets my hunk only.
    const admitted = admitPathsOntoRepairHead({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], source: { ref: built.sourceCommit }, actor: 'me', nowMs: T0 });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.detail);
    expect(show(root, admitted.commit, 'lib/a.ts')).toBe('export const a = 10;\nexport const b = 2;\n');
    expect(admitted.diff).toEqual(['lib/a.ts']);
  });

  it('includeHunksFrom replays the named peer\'s hunks too — the explicit widening, never chosen by the tool', () => {
    const { root, candidate } = repo();
    const ledger = [
      row('me', 'lib/a.ts', { kind: 'edit', old: 'export const a = 1;', new: 'export const a = 10;', replaceAll: false }),
      row('peer', 'lib/a.ts', { kind: 'edit', old: 'export const b = 2;', new: 'export const b = 20;', replaceAll: false }),
    ];
    const built = buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], ledger, actor: 'me', includeHunksFrom: ['peer'], nowMs: T0 });
    if (!built.ok) throw new Error(built.detail);
    expect(show(root, built.sourceCommit, 'lib/a.ts')).toBe('export const a = 10;\nexport const b = 20;\n');
    expect(built.perPath[0]).toMatchObject({ applied: 2, agents: ['me', 'peer'], foreignHunks: 0 });
  });

  it('no-ledgered-hunks: a path the caller never ledgered is refused naming the peers who did and BOTH exits', () => {
    const { root, candidate } = repo();
    const ledger = [row('peer', 'lib/a.ts', { kind: 'write', body: 'theirs' })];
    const built = buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], ledger, actor: 'me', nowMs: T0 });
    expect(built).toMatchObject({ ok: false, code: 'no-ledgered-hunks', path: 'lib/a.ts', foreignAgents: ['peer'] });
    if (built.ok) throw new Error('unreachable');
    expect(built.exits.some((e) => e.includes('includeHunksFrom:["peer"]'))).toBe(true);
    expect(built.exits.some((e) => e.includes('wholeBlob:true'))).toBe(true);
  });

  it('hunk-conflict: a hunk made on top of a foreign change does not apply to repairHead\'s blob — refused, hunk + peers named', () => {
    const { root, candidate } = repo();
    const ledger = [
      row('peer', 'lib/a.ts', { kind: 'edit', old: 'export const b = 2;', new: 'export const b = 20;', replaceAll: false }),
      // My edit anchors on the peer's NEW text — it depends on their change.
      row('me', 'lib/a.ts', { kind: 'edit', old: 'export const b = 20;', new: 'export const b = 21;', replaceAll: false }),
    ];
    const built = buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['lib/a.ts'], ledger, actor: 'me', nowMs: T0 });
    expect(built).toMatchObject({ ok: false, code: 'hunk-conflict', path: 'lib/a.ts', hunkIndex: 0, foreignAgents: ['peer'] });
    if (built.ok) throw new Error('unreachable');
    expect(built.detail).toContain('hunk #1');
    expect(built.detail).toContain('peer');
  });

  it('an oversize (content-less) hunk cannot be replayed; a write creates a path repairHead lacks; replaying to the same bytes reads as unchanged', () => {
    const { root, candidate } = repo();
    const oversize = buildHunkExactSource({
      root, candidate, repairHead: candidate, paths: ['lib/a.ts'], actor: 'me', nowMs: T0,
      ledger: [row('me', 'lib/a.ts', { kind: 'oversize', of: 'write', bytes: 9, sha256: 'f'.repeat(64) })],
    });
    expect(oversize).toMatchObject({ ok: false, code: 'oversize' });

    const created = buildHunkExactSource({
      root, candidate, repairHead: candidate, paths: ['lib/new.ts'], actor: 'me', nowMs: T0,
      ledger: [row('me', 'lib/new.ts', { kind: 'write', body: 'export const n = 1;\n' })],
    });
    if (!created.ok) throw new Error(created.detail);
    expect(show(root, created.sourceCommit, 'lib/new.ts')).toBe('export const n = 1;\n');
    expect(created.perPath[0]).toMatchObject({ baseBlob: null, unchanged: false });

    const same = buildHunkExactSource({
      root, candidate, repairHead: candidate, paths: ['lib/a.ts'], actor: 'me', nowMs: T0,
      ledger: [row('me', 'lib/a.ts', { kind: 'write', body: BASE_A })],
    });
    if (!same.ok) throw new Error(same.detail);
    expect(same.allUnchanged).toBe(true);
    expect(same.tree).toBe(git(root, ['rev-parse', `${candidate}^{tree}`]));
  });

  it('refuses malformed paths and an unresolvable repairHead without building anything', () => {
    const { root, candidate } = repo();
    expect(buildHunkExactSource({ root, candidate, repairHead: candidate, paths: ['../x'], ledger: [], actor: 'me', nowMs: T0 })).toMatchObject({ ok: false, code: 'invalid-paths' });
    expect(buildHunkExactSource({ root, candidate, repairHead: 'f'.repeat(40), paths: ['lib/a.ts'], ledger: [], actor: 'me', nowMs: T0 })).toMatchObject({ ok: false, code: 'repair-head-unresolvable' });
  });
});

describe('summarizeForeignHunks — what a whole-blob admission may carry (D-008 layer 3b)', () => {
  it('counts ledgered hunks on the paths by agents other than the actor (∪ include)', () => {
    const ledger = [
      row('me', 'lib/a.ts', { kind: 'write', body: 'x' }),
      row('peer', 'lib/a.ts', { kind: 'write', body: 'y' }),
      row('peer', 'lib/a.ts', { kind: 'write', body: 'z' }),
      row('other', 'lib/b.ts', { kind: 'write', body: 'w' }),
      row('other', 'lib/c.ts', { kind: 'write', body: 'v' }), // not admitted — not counted
    ];
    expect(summarizeForeignHunks(ledger, ['./lib/a.ts', 'lib/b.ts'], 'me')).toEqual({ count: 3, agents: ['other', 'peer'], byPath: { 'lib/a.ts': 2, 'lib/b.ts': 1 } });
    expect(summarizeForeignHunks(ledger, ['lib/a.ts'], 'me', ['peer'])).toEqual({ count: 0, agents: [], byPath: {} });
  });
});
