/**
 * install-from-repo tests (learning-packs-2026-06-11 P-017) — the fetch path's
 * guards. `cloneGithubRepo` is mocked to "clone" into a real tmp fixture dir
 * (so the candidate-dir resolution + the real loader/validator run); the
 * installed root is redirected to a tmp dir so the copy lands under test
 * control. Pins: clone-error pass-through, candidate-dir precedence
 * (learning-packs/<ref> over a root manifest), pack_not_found, pack_invalid,
 * pack_id_mismatch, the happy copy, and temp-clone cleanup.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../harness/clone-github', async (orig) => {
  const actual = await orig<typeof import('../harness/clone-github')>();
  return { ...actual, cloneGithubRepo: vi.fn() };
});
vi.mock('./load-packs', async (orig) => {
  const actual = await orig<typeof import('./load-packs')>();
  return { ...actual, installedLearningPacksRoot: vi.fn() };
});

import { cloneGithubRepo } from '../harness/clone-github';
import { installedLearningPacksRoot } from './load-packs';
import { fetchLearningPackFromRepo } from './install-from-repo';

const mockClone = vi.mocked(cloneGithubRepo);
const mockRoot = vi.mocked(installedLearningPacksRoot);

let scratch: string;
let installRoot: string;

/** Write a valid pack dir at <base>/<rel> and return its absolute path. */
function writePack(
  base: string,
  rel: string,
  manifest: { id: string; version?: string },
  items: Array<{ file: string; title: string; body: string }>,
) {
  const dir = join(base, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.yaml'),
    [`id: ${manifest.id}`, 'title: T', 'description: D', `version: ${manifest.version ?? '1.0.0'}`, ''].join('\n'),
    'utf8',
  );
  for (const it of items) {
    writeFileSync(join(dir, it.file), `---\ntitle: ${it.title}\n---\n\n${it.body}\n`, 'utf8');
  }
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
  scratch = mkdtempSync(join(tmpdir(), 'pc-lp-repo-'));
  installRoot = mkdtempSync(join(tmpdir(), 'pc-lp-installed-'));
  mockRoot.mockReturnValue(installRoot);
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(installRoot, { recursive: true, force: true });
});

/** Make cloneGithubRepo "clone" into a prepared dir under scratch. */
const cloneInto = (relRepoDir: string) => {
  const repoPath = join(scratch, relRepoDir);
  mockClone.mockResolvedValue({ path: repoPath, parsed: {} as never });
  return repoPath;
};

describe('fetchLearningPackFromRepo', () => {
  it('passes a clone error straight through (code + detail)', async () => {
    mockClone.mockResolvedValue({ code: 'not_found', message: 'Repository not found' });
    const res = await fetchLearningPackFromRepo({ githubUrl: 'https://github.com/x/y', listingRef: 'p' });
    expect(res).toMatchObject({ ok: false, error: 'not_found', detail: 'Repository not found' });
  });

  it('pack_not_found_in_repo when neither learning-packs/<ref> nor a root manifest exists', async () => {
    const repo = cloneInto('repo1');
    mkdirSync(repo, { recursive: true }); // empty repo, no manifest anywhere
    const res = await fetchLearningPackFromRepo({ githubUrl: 'u', listingRef: 'missing-pack' });
    expect(res).toMatchObject({ ok: false, error: 'pack_not_found_in_repo' });
    expect(res.detail).toMatch(/learning-packs\/missing-pack/);
  });

  it('prefers learning-packs/<ref> over a root manifest (candidate precedence)', async () => {
    const repo = cloneInto('repo2');
    // Root pack (wrong) + the listing-ref pack (right) — the ref wins.
    writePack(repo, '.', { id: 'root-pack' }, [{ file: 'r.md', title: 'R', body: 'root body' }]);
    writePack(repo, 'learning-packs/wanted', { id: 'wanted' }, [{ file: 'w.md', title: 'W', body: 'wanted body' }]);
    const res = await fetchLearningPackFromRepo({ githubUrl: 'u', listingRef: 'wanted' });
    expect(res).toMatchObject({ ok: true });
    expect(res.pack?.id).toBe('wanted');
    expect(existsSync(join(installRoot, 'wanted', 'manifest.yaml'))).toBe(true);
  });

  it('a repo that IS one pack (root manifest, no listingRef) loads', async () => {
    const repo = cloneInto('repo3');
    writePack(repo, '.', { id: 'solo-pack' }, [{ file: 's.md', title: 'S', body: 'solo body' }]);
    const res = await fetchLearningPackFromRepo({ githubUrl: 'u' });
    expect(res).toMatchObject({ ok: true });
    expect(res.pack).toMatchObject({ id: 'solo-pack', itemCount: 1 });
  });

  it('pack_invalid when the pack dir has a malformed manifest', async () => {
    const repo = cloneInto('repo4');
    const dir = join(repo, 'learning-packs', 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.yaml'), 'id: bad\ntitle: t\ndescription: d\nversion: NOT_SEMVER\n', 'utf8');
    writeFileSync(join(dir, 'x.md'), '---\ntitle: X\n---\n\nbody\n', 'utf8');
    const res = await fetchLearningPackFromRepo({ githubUrl: 'u', listingRef: 'bad' });
    expect(res).toMatchObject({ ok: false, error: 'pack_invalid' });
  });

  it('pack_id_mismatch when the manifest id disagrees with listing_ref', async () => {
    const repo = cloneInto('repo5');
    writePack(repo, 'learning-packs/claimed', { id: 'actual-id' }, [{ file: 'a.md', title: 'A', body: 'b' }]);
    const res = await fetchLearningPackFromRepo({ githubUrl: 'u', listingRef: 'claimed' });
    expect(res).toMatchObject({ ok: false, error: 'pack_id_mismatch' });
    expect(res.detail).toMatch(/actual-id/);
  });

  it('cleans up the temp clone dir even on the happy path', async () => {
    const repo = cloneInto('repo6');
    writePack(repo, '.', { id: 'cleanme' }, [{ file: 'c.md', title: 'C', body: 'body' }]);
    const res = await fetchLearningPackFromRepo({ githubUrl: 'u' });
    expect(res.ok).toBe(true);
    // The mkdtemp clone dir (the parent passed to cloneGithubRepo) is removed.
    const clonesDirArg = mockClone.mock.calls[0][1] as { clonesDir: string };
    expect(existsSync(clonesDirArg.clonesDir)).toBe(false);
  });
});
