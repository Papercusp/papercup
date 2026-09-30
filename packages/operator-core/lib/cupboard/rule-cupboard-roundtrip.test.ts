/**
 * The rule Cupboard round trip (portable-identity-packages-2026-09-26 P-011,
 * D-023 §6 — the D-055 gap).
 *
 * Invokes the real rule publish/install cores across the self-describing store on
 * a hermetic PAPERCUSP_HOME; git, GitHub metadata and the listing write are the
 * dependency seams, exactly as in plan-rubric-recipe-roundtrip.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetPapercuspRootForTests } from '../papercusp-root';

const external = vi.hoisted(() => ({
  publishListingToCupboard: vi.fn(),
  parseGithubRemote: vi.fn(),
  fetchGithubRepoMeta: vi.fn(),
}));

vi.mock('./publish-listing', () => ({
  publishListingToCupboard: external.publishListingToCupboard,
}));

vi.mock('./resolve-repo-coords', () => ({
  parseGithubRemote: external.parseGithubRemote,
  fetchGithubRepoMeta: external.fetchGithubRepoMeta,
}));

import { publishRuleToCupboard } from './publish-rule-core';
import { installRuleFromCupboardCore, InstallRuleError } from './install-rule-core';
import { resolveLocalRule } from './rule-store';

const GITHUB_URL = 'https://github.com/acme/cupboard-rules';

const guardRule = (id: string) => ({
  schemaVersion: 1, id, title: `Rule ${id}`, description: 'Refuse recursive deletes.', version: '1.0.0',
  delivery: 'sync', sink: 'pre-tool', tools: ['capability:bash'],
  guard: { deny: { 'args.command': { matches: 'rm -rf' } }, reason: 'no recursive deletes' },
});

async function writeRuleDir(parent: string, ref: string, manifest: unknown = guardRule(ref)): Promise<string> {
  const dir = join(parent, ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'rule.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(join(dir, 'listing.json'), `${JSON.stringify({ kind: 'rule', version: '1.0.0' })}\n`, 'utf8');
  return dir;
}

/** Unpinned install: only the tip-clone path may run (the pinned path has its own
 *  suite in install-self-describing-core.test.ts). */
function unpinnedDeps(repo: string, tmp: string) {
  return {
    cloneRepo: async (_url: string, dest: string) => { await fs.cp(repo, dest, { recursive: true }); },
    fetchAtSha: async (): Promise<void> => { throw new Error('unpinned roundtrip: fetchAtSha must not be called'); },
    listTreeBlobs: async (): Promise<never> => { throw new Error('unpinned roundtrip: listTreeBlobs must not be called'); },
    tmpDir: () => tmp,
  };
}

let root: string;
let previousPapercuspHome: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'cupboard-rule-roundtrip-'));
  previousPapercuspHome = process.env.PAPERCUSP_HOME;
  process.env.PAPERCUSP_HOME = root;
  _resetPapercuspRootForTests();
  external.publishListingToCupboard.mockReset();
  external.publishListingToCupboard.mockResolvedValue({ ok: true, data: { id: 'listing-1', review_status: 'pending' } });
  external.parseGithubRemote.mockReset();
  external.parseGithubRemote.mockReturnValue({ owner: 'acme', repo: 'cupboard-rules' });
  external.fetchGithubRepoMeta.mockReset();
  external.fetchGithubRepoMeta.mockResolvedValue({ id: 4242, html_url: GITHUB_URL });
});

afterEach(async () => {
  if (previousPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = previousPapercuspHome;
  _resetPapercuspRootForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe('rule Cupboard round trip', () => {
  it('publishes a local rule as a rule listing', async () => {
    await writeRuleDir(join(root, 'rules', 'installed'), 'no-rm-rf');

    const result = await publishRuleToCupboard({ ref: 'no-rm-rf', github_url: GITHUB_URL });

    expect(result).toMatchObject({ ok: true, listing: { id: 'listing-1', review_status: 'pending' } });
    expect(external.publishListingToCupboard).toHaveBeenCalledWith(expect.objectContaining({
      listing_kind: 'rule', listing_ref: 'no-rm-rf', title: 'Rule no-rm-rf', github_repository_id: 4242,
    }));
  });

  it('refuses to advertise a rule that is absent or does not parse', async () => {
    await writeRuleDir(join(root, 'rules', 'installed'), 'mixed', {
      ...guardRule('mixed'), sink: 'stop',
    });

    for (const ref of ['missing', 'mixed']) {
      expect(await publishRuleToCupboard({ ref, github_url: GITHUB_URL })).toMatchObject({ ok: false, status: 404 });
    }
    expect(await publishRuleToCupboard({ ref: '../escape', github_url: GITHUB_URL })).toMatchObject({ ok: false, status: 400 });
    expect(external.fetchGithubRepoMeta).not.toHaveBeenCalled();
    expect(external.publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('installs a sync rule into the user layer where the store resolves it', async () => {
    const repo = join(root, 'rule-repo');
    await writeRuleDir(repo, 'no-rm-rf');

    const result = await installRuleFromCupboardCore(
      { githubUrl: GITHUB_URL, listingRef: 'no-rm-rf' }, unpinnedDeps(repo, root));

    expect(result).toMatchObject({
      ok: true, ref: 'no-rm-rf', ruleId: 'no-rm-rf', delivery: 'sync', sink: 'pre-tool',
      source: GITHUB_URL, installedTo: join(root, 'rules', 'installed', 'no-rm-rf'), pin: null,
    });
    expect(resolveLocalRule('no-rm-rf')).toMatchObject({ layer: 'user', delivery: 'sync', sink: 'pre-tool' });
  });

  it('refuses a manifest that the store would not read, before anything lands', async () => {
    const repo = join(root, 'rule-repo');
    // A guard off the pre-tool sink is a shape error, not a reroute.
    await writeRuleDir(repo, 'guard-at-stop', { ...guardRule('guard-at-stop'), sink: 'stop' });

    const install = installRuleFromCupboardCore(
      { githubUrl: GITHUB_URL, listingRef: 'guard-at-stop' }, unpinnedDeps(repo, root));

    await expect(install).rejects.toBeInstanceOf(InstallRuleError);
    await expect(install).rejects.toThrow('rule "guard-at-stop" failed to parse its rule.json');
    await expect(fs.stat(join(root, 'rules', 'installed', 'guard-at-stop'))).rejects.toThrow();
  });
});
