import { execFileSync } from 'node:child_process';
import { cp, link, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureOffloadLinks, verifyOffloadLinks } from './offload-link-integrity';
import { retainNativeProofPacket, verifyNativeProofPacket,
  type NativeCustodyGroup } from '../../../../scripts/lib/budgeted-task-scheduler.mjs';

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'offload-links-'));
  fixtures.push(root);
  const source = join(root, 'original', 'node_modules');
  const destination = join(root, 'offload', 'node_modules');
  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'offload'));
  return { root, source, destination };
}

describe('offload symlink target integrity', () => {
  it('refuses tracked source before relocation and through an existing offload symlink', async () => {
    const f = await fixture();
    const repo = join(f.root, 'original');
    execFileSync('git', ['init', '--quiet', repo]);
    const file = join(f.source, 'source.ts');
    await writeFile(file, 'export const value = 1;');
    const object = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--', file], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', repo, 'update-index', '--add', '--cacheinfo', '100644', object, 'node_modules/source.ts']);
    await expect(captureOffloadLinks(f.source)).rejects.toThrow('Git-tracked source');
    await rename(f.source, f.destination);
    await symlink(f.destination, f.source);
    expect(execFileSync('git', ['-C', repo, 'diff-files', '--name-only'], { encoding: 'utf8' }))
      .toContain('node_modules/source.ts');
    expect(await readFile(join(f.source, 'source.ts'), 'utf8')).toContain('value = 1');
    await expect(captureOffloadLinks(f.source)).rejects.toThrow('Git-tracked source');
  });

  it('allows untracked generated directories in a repository and refuses nested repositories', async () => {
    const f = await fixture();
    execFileSync('git', ['init', '--quiet', join(f.root, 'original')]);
    await writeFile(join(f.source, 'generated'), 'payload');
    expect((await captureOffloadLinks(f.source)).entriesVisited).toBe(1);
    execFileSync('git', ['init', '--quiet', join(f.source, 'nested')]);
    await expect(captureOffloadLinks(f.source)).rejects.toThrow('Git source tree');
    await expect(captureOffloadLinks(join(f.root, 'original'))).rejects.toThrow('Git source tree');
  });

  it('refuses publication when a directory-only Git ignore exposes the offload alias', async () => {
    const f = await fixture();
    const repo = join(f.root, 'original');
    execFileSync('git', ['init', '--quiet', repo]);
    await writeFile(join(repo, '.gitignore'), '/node_modules/\n');
    await writeFile(join(f.source, 'generated'), 'payload');
    const snapshot = await captureOffloadLinks(f.source);
    await cp(f.source, f.destination, { recursive: true });
    expect((await verifyOffloadLinks(snapshot, f.destination)).ok).toBe(true);
    await rename(f.source, `${f.source}.aside`);
    await symlink(f.destination, f.source);
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', 'node_modules'], { encoding: 'utf8' }))
      .toContain('?? node_modules');
    for (const path of [f.destination, f.source]) {
      expect(await verifyOffloadLinks(snapshot, path)).toMatchObject({ ok: false,
        violations: [{ path: f.source, reason: 'git-publication-exposed' }] });
    }
    expect(await readFile(join(`${f.source}.aside`, 'generated'), 'utf8')).toBe('payload');
    await writeFile(join(repo, '.git', 'info', 'exclude'), '/node_modules\n');
    expect((await verifyOffloadLinks(snapshot, f.source)).ok).toBe(true);
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', 'node_modules'], { encoding: 'utf8' }))
      .toBe('');
  });

  it('requires planned aside names to stay outside Git publication before moving the source', async () => {
    const f = await fixture();
    const repo = join(f.root, 'original');
    execFileSync('git', ['init', '--quiet', repo]);
    await writeFile(join(repo, '.gitignore'), '/node_modules\n');
    const aside = `${f.source}.offload-aside`;
    await expect(captureOffloadLinks(f.source, { publicationPaths: [aside] }))
      .rejects.toThrow('Git publication');
    await writeFile(join(repo, '.git', 'info', 'exclude'), '/node_modules.offload-aside\n');
    const snapshot = await captureOffloadLinks(f.source, { publicationPaths: [aside] });
    await cp(f.source, f.destination, { recursive: true });
    await rename(f.source, aside);
    await symlink(f.destination, f.source);
    expect((await verifyOffloadLinks(snapshot, f.source)).ok).toBe(true);
    await writeFile(join(repo, '.git', 'info', 'exclude'), '');
    expect(await verifyOffloadLinks(snapshot, f.source)).toMatchObject({ ok: false,
      violations: [{ path: aside, reason: 'git-publication-exposed' }] });
  });

  it.each(['packet', 'nested/packet'])('refuses %s whose native consumer rejects redirected ancestors', async relativePacket => {
    const f = await fixture();
    const packet = join(f.source, relativePacket);
    const expected: NativeCustodyGroup[] = [{ id: 'group-0', attempt: 'primary', selected: ['test.ts'],
      runner: 'unsupported', armed: false, out: null, auxiliary: [] }];
    const contract = { identity: { workspace: 'fixture', harness: 'papercusp', runId: relativePacket }, expected };
    const saved = retainNativeProofPacket(packet, { ...contract, observations: [{ id: 'group-0', out: null }] });
    expect(verifyNativeProofPacket(packet, saved.locator, contract).status).toBe(saved.status);
    await expect(captureOffloadLinks(f.source)).rejects.toThrow('Native proof custody');

    await cp(f.source, f.destination, { recursive: true, verbatimSymlinks: true });
    await rm(f.source, { recursive: true });
    await symlink(f.destination, f.source);
    expect(() => verifyNativeProofPacket(packet, saved.locator, contract)).toThrow('custody redirected ancestor');
  });

  it('refuses a source that can be mutated through a hard link outside its path prefix', async () => {
    const f = await fixture();
    const activeLock = join(f.root, 'live-lock.json');
    await writeFile(activeLock, 'old lock');
    await link(activeLock, join(f.source, '.package-lock.json'));
    await writeFile(activeLock, 'new lock');
    expect(await readFile(join(f.source, '.package-lock.json'), 'utf8')).toBe('new lock');
    await expect(captureOffloadLinks(f.source)).rejects.toThrow('external hard links');
  });

  it('accepts fully contained hard links and rejects a new outside alias on the next source preflight', async () => {
    const f = await fixture();
    await writeFile(join(f.source, 'a'), 'payload');
    await link(join(f.source, 'a'), join(f.source, 'b'));
    expect((await captureOffloadLinks(f.source)).entriesVisited).toBe(2);
    await link(join(f.source, 'a'), join(f.root, 'new-alias'));
    await expect(captureOffloadLinks(f.source)).rejects.toThrow('2/3 links inside root');
  });

  it('rejects identical link text resolving to an existing but different sibling', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'original', 'libs'));
    await mkdir(join(f.root, 'offload', 'libs'));
    await writeFile(join(f.root, 'original', 'libs', 'value'), 'correct');
    await writeFile(join(f.root, 'offload', 'libs', 'value'), 'wrong');
    await symlink('../libs/value', join(f.source, 'dependency'));
    const snapshot = await captureOffloadLinks(f.source);
    await cp(f.source, f.destination, { recursive: true, verbatimSymlinks: true });
    expect(await readlink(join(f.destination, 'dependency'))).toBe('../libs/value');
    const proof = await verifyOffloadLinks(snapshot, f.destination);
    expect(proof.ok).toBe(false);
    expect(proof.violations).toEqual([{ path: 'dependency', reason: 'target-changed',
      expected: join(f.root, 'original', 'libs', 'value'), actual: join(f.root, 'offload', 'libs', 'value') }]);
  });

  it('verifies namespace anchors, internal chains, and public cutover after original removal', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'original', 'libs'));
    await writeFile(join(f.root, 'original', 'libs', 'value'), 'external');
    await writeFile(join(f.source, 'payload'), 'internal');
    await symlink('../libs/value', join(f.source, 'external'));
    await symlink('payload', join(f.source, 'internal'));
    await symlink('internal', join(f.source, 'chain'));
    const snapshot = await captureOffloadLinks(f.source);
    await cp(f.source, f.destination, { recursive: true, verbatimSymlinks: true });
    await symlink(join(f.root, 'original', 'libs'), join(f.root, 'offload', 'libs'));
    expect(await verifyOffloadLinks(snapshot, f.destination)).toMatchObject({ ok: true, checkedLinks: 3 });
    await rename(f.source, `${f.source}.aside`);
    await symlink(f.destination, f.source);
    await rm(`${f.source}.aside`, { recursive: true });
    expect(await verifyOffloadLinks(snapshot, f.source)).toMatchObject({ ok: true, checkedLinks: 3 });
  });

  it('checks absolute external links and does not confuse a shared path prefix with containment', async () => {
    const f = await fixture();
    const sibling = `${f.source}-sibling`;
    await mkdir(sibling);
    await writeFile(join(sibling, 'value'), 'external');
    await symlink(join(sibling, 'value'), join(f.source, 'dependency'));
    const snapshot = await captureOffloadLinks(f.source);
    await cp(f.source, f.destination, { recursive: true, verbatimSymlinks: true });
    expect((await verifyOffloadLinks(snapshot, f.destination)).ok).toBe(true);
  });

  it('rejects missing, added, rewritten and broken destination links', async () => {
    const f = await fixture();
    await writeFile(join(f.source, 'payload'), 'value');
    await symlink('payload', join(f.source, 'removed'));
    await symlink('payload', join(f.source, 'rewritten'));
    const snapshot = await captureOffloadLinks(f.source);
    await cp(f.source, f.destination, { recursive: true, verbatimSymlinks: true });
    await rm(join(f.destination, 'removed'));
    await rm(join(f.destination, 'rewritten'));
    await symlink('missing', join(f.destination, 'rewritten'));
    await symlink('payload', join(f.destination, 'added'));
    const proof = await verifyOffloadLinks(snapshot, f.destination);
    expect(proof.ok).toBe(false);
    expect(proof.violations).toEqual(expect.arrayContaining([
      { path: 'removed', reason: 'missing-link' },
      expect.objectContaining({ path: 'rewritten', reason: 'link-text-changed' }),
      expect.objectContaining({ path: 'rewritten', reason: 'target-unresolved' }),
      { path: 'added', reason: 'unexpected-link' },
    ]));
  });

  it('fails closed for broken/cyclic originals, incomplete walks and cancelled work', async () => {
    const f = await fixture();
    await symlink('absent', join(f.source, 'broken'));
    await expect(captureOffloadLinks(f.source)).rejects.toThrow('unresolved');
    await rm(join(f.source, 'broken'));
    await symlink('cycle', join(f.source, 'cycle'));
    await expect(captureOffloadLinks(f.source)).rejects.toThrow('unresolved');
    await rm(join(f.source, 'cycle'));
    await writeFile(join(f.source, 'a'), 'a');
    await writeFile(join(f.source, 'b'), 'b');
    await expect(captureOffloadLinks(f.source, { maxEntries: 1 })).rejects.toThrow('exceeded');
    await expect(captureOffloadLinks(f.source, { signal: AbortSignal.abort() })).rejects.toThrow();
    const snapshot = await captureOffloadLinks(f.source);
    await expect(verifyOffloadLinks(snapshot, f.source)).rejects.toThrow('original source');
  });
});
