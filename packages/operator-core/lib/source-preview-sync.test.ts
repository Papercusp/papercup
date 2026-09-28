/**
 * scripts/source-preview.mjs check / push — plan dhh-source-preview-2026-09-28
 * R-3 / R-6 (P-003, P-004).
 *
 * The preview is re-synced by ONE command, and that command may only publish a
 * gated export: a failing gate pushes nothing, a missing --confirm pushes
 * nothing, and a confirmed push REPLACES the preview with a single orphan
 * commit (no source history ever reaches it). `check` reports drift between the
 * preview and a fresh export of the source ref.
 *
 * The remote is a local bare repository under tmpdir and the gate is injected,
 * so these cases pin the sync contract without network or scanners.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDrift, pushSnapshot, remoteTreeSha } from '../../../scripts/source-preview.mjs';
import { childEnv, git, makeSuperproject, write, type Superproject } from './source-preview.fixture';

let tmp: string;
let fx: Superproject;
let remote: string;
let bare: string;

const passing = async () => ({ ok: true, exitCode: 0, results: [] });
const failing = async () => ({ ok: false, exitCode: 1, results: [{ name: 'gitleaks', ok: false, status: 'finding', detail: 'x' }] });

function remoteGit(args: string[]): string {
  const r = spawnSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const hasMain = () => spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', 'refs/heads/main']).status === 0;
const opts = (extra = {}) => ({ repoRoot: fx.repo, ref: 'main', remote, env: childEnv(), ...extra });

function commitChange(rel: string, body: string, msg: string): string {
  write(fx.repo, rel, body);
  git(fx.repo, ['add', '-A', '-f']);
  git(fx.repo, ['commit', '-q', '-m', msg]);
  return git(fx.repo, ['rev-parse', 'HEAD']);
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'source-preview-sync-test-'));
  fx = makeSuperproject(tmp);
  bare = join(tmp, 'preview.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  remote = `file://${bare}`;
}, 120_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('source-preview sync — nothing is published without a clean gate and --confirm', () => {
  it('reports drift while the preview has no main branch yet', async () => {
    const r = await checkDrift(opts());
    expect(r).toMatchObject({ inSync: false, actual: null, commit: fx.commit });
    expect(r.expected).toMatch(/^[0-9a-f]{40}$/);
  }, 120_000);

  it('pushes nothing when the gate refuses', async () => {
    const r = await pushSnapshot(opts({ confirm: true, gate: failing }));
    expect(r).toMatchObject({ pushed: false, reason: 'gate' });
    expect(hasMain()).toBe(false);
  }, 120_000);

  it('gates the export itself, before anything is committed', async () => {
    let gated: string | undefined;
    let manifestPresent = false;
    const spy = async (dir: string) => {
      gated = dir;
      manifestPresent = existsSync(join(dir, 'MANIFEST.json'));
      return passing();
    };
    await pushSnapshot(opts({ gate: spy }));
    expect(gated).toBeDefined();
    expect(manifestPresent).toBe(true);
    expect(hasMain()).toBe(false);
  }, 120_000);

  it('pushes nothing on a dry run', async () => {
    const r = await pushSnapshot(opts({ gate: passing }));
    expect(r).toMatchObject({ pushed: false, reason: 'dry-run', commit: fx.commit });
    expect(hasMain()).toBe(false);
  }, 120_000);
});

describe('source-preview sync — a confirmed push publishes one orphan commit', () => {
  it('publishes the export as a single parentless commit and then reads as in sync', async () => {
    const r = await pushSnapshot(opts({ confirm: true, gate: passing }));
    expect(r).toMatchObject({ pushed: true, commit: fx.commit });
    expect(remoteGit(['rev-list', '--count', 'main'])).toBe('1');
    expect(remoteGit(['rev-list', '--parents', '-n', '1', 'main']).split(' ')).toHaveLength(1);
    expect(remoteGit(['log', '-1', '--format=%an <%ae>', 'main'])).toBe('Papercusp <source-preview@papercusp.invalid>');
    expect(remoteGit(['log', '-1', '--format=%B', 'main'])).toContain(fx.commit.slice(0, 12));
    expect(remoteTreeSha(remote)).toBe(r.tree);

    const check = await checkDrift(opts());
    expect(check).toMatchObject({ inSync: true, expected: r.tree, actual: r.tree });
  }, 120_000);

  it('does not push again when already in sync', async () => {
    const before = remoteGit(['rev-parse', 'main']);
    const r = await pushSnapshot(opts({ confirm: true, gate: passing }));
    expect(r).toMatchObject({ pushed: false, reason: 'in-sync' });
    expect(remoteGit(['rev-parse', 'main'])).toBe(before);
  }, 120_000);

  it('stays in sync when only a path the preview drops changes', async () => {
    commitChange('scratch/notes.md', 'more scratch\n', 'scratch only');
    expect(await checkDrift(opts())).toMatchObject({ inSync: true });
  }, 120_000);

  it('detects drift after a shipped file changes, and a re-push replaces the preview with one new orphan commit', async () => {
    const first = remoteGit(['rev-parse', 'main']);
    const head = commitChange('apps/operator/src/index.ts', 'export const x = 2;\n', 'ship a change');
    const drift = await checkDrift(opts());
    expect(drift).toMatchObject({ inSync: false, commit: head });

    const r = await pushSnapshot(opts({ confirm: true, gate: passing }));
    expect(r).toMatchObject({ pushed: true, commit: head });
    expect(remoteGit(['rev-list', '--count', 'main'])).toBe('1');
    expect(remoteGit(['rev-parse', 'main'])).not.toBe(first);
    expect(remoteGit(['show', 'main:apps/operator/src/index.ts'])).toBe('export const x = 2;');
    expect(await checkDrift(opts())).toMatchObject({ inSync: true });
  }, 180_000);
});
