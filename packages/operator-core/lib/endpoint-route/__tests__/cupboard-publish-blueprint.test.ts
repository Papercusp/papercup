/**
 * POST /cupboard/publish-blueprint — public-visibility gate
 * (cupboard-full-dogfood-2026-07-10 P-002 durable guardrail).
 *
 * A blueprint is publishable to the public Cupboard ONLY when its blueprint.yaml
 * declares `visibility: public`. These tests pin the route wiring: an unmarked /
 * internal blueprint 422s and NEVER reaches the GitHub resolution or the
 * publisher (fail-closed, fail-fast), and a public blueprint publishes as
 * listing_kind='blueprint'.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Map blueprint id → an on-disk blueprint.yaml the route reads with real fs.
const bpPath: Record<string, string> = {};

// What the fake `git clone` of github_url materializes: a multi-blueprint library
// (one top-level dir per blueprint), exactly the layout the official mirror serves.
let servedIds: string[] = ['coding', 'base'];
const clonedTo: string[] = [];
// What the release preparer was handed, captured WHILE the clone still exists
// (the route removes the clone afterwards, so a later read would fall through).
const prepareSaw: Array<{ blueprintFile: string; blueprintExists: boolean; base: string | null }> = [];

vi.mock('../../blueprint/installed-blueprints', () => ({
  operatorResolveExtends: () => (id: string) => bpPath[id] ?? null,
}));
vi.mock('../../cupboard/install-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../cupboard/install-io')>()),
  gitCloneShallow: vi.fn(async (_url: string, dest: string) => {
    clonedTo.push(dest);
    for (const id of servedIds) {
      mkdirSync(join(dest, id), { recursive: true });
      writeFileSync(join(dest, id, 'blueprint.yaml'), `id: ${id}\nvisibility: public\n# served copy\n`, 'utf8');
    }
    mkdirSync(dest, { recursive: true });
  }),
}));
vi.mock('../../cupboard/publish-listing', () => ({
  publishListingToCupboard: vi.fn(async () => ({ ok: true, status: 200, data: { id: 'lst-bp-1' } })),
}));
vi.mock('../../cupboard/resolve-repo-coords', () => ({
  parseGithubRemote: vi.fn(() => ({ owner: 'Papercusp', repo: 'blueprints' })),
  fetchGithubRepoMeta: vi.fn(async () => ({ id: 42, html_url: 'https://github.com/Papercusp/blueprints' })),
}));
vi.mock('../../cupboard/blueprint-release', () => {
  class BlueprintLifecycleError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
  return {
    BlueprintLifecycleError,
    prepareBlueprintPublicRelease: vi.fn(async ({ listingRef, blueprintFile, resolveExtends }: {
      listingRef: string;
      blueprintFile: string;
      resolveExtends: (id: string) => string | null;
    }) => {
      prepareSaw.push({ blueprintFile, blueprintExists: existsSync(blueprintFile), base: resolveExtends('base') });
      return {
      source: {
        id: listingRef,
        version: '1.0.0',
        raw: { id: listingRef },
        archive: {
          package: { rootHash: `sha256:${'a'.repeat(64)}` },
          root: { contentHash: 'b'.repeat(64) },
          pins: [],
        },
      },
      release: { visibility: 'public', manifest: {}, bytes: Buffer.from('release') },
      manifest: {},
      };
    }),
  };
});

import route from '../routes/cupboard-publish-blueprint';
import { publishListingToCupboard } from '../../cupboard/publish-listing';
import { parseGithubRemote, fetchGithubRepoMeta } from '../../cupboard/resolve-repo-coords';
import { gitCloneShallow } from '../../cupboard/install-io';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bp-vis-'));
  const write = (id: string, yaml: string) => {
    const p = join(tmpRoot, `${id}.yaml`);
    writeFileSync(p, yaml, 'utf8');
    bpPath[id] = p;
  };
  write('coding', 'id: coding\nvisibility: public\ndescription: The coding hive\n');
  write('audit', 'id: audit\nkind: harness\ndescription: Internal audit loop\n');
  write('papercup', 'id: papercup\nvisibility: internal\ndescription: Internal infra\n');
  // The publisher's LOCAL parent — deliberately a different file from the served
  // `base`, as the official mirror's base differs from the bundled one.
  write('base', 'id: base\n# host copy\n');
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  const req = new Request('http://localhost/cupboard/publish-blueprint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (route as unknown as { handler: (req: Request) => Promise<Response> }).handler(req);
}

beforeEach(() => {
  vi.mocked(publishListingToCupboard).mockClear();
  vi.mocked(publishListingToCupboard).mockResolvedValue({ ok: true, status: 200, data: { id: 'lst-bp-1' } });
  vi.mocked(parseGithubRemote).mockClear();
  vi.mocked(parseGithubRemote).mockReturnValue({ owner: 'Papercusp', repo: 'blueprints' } as never);
  vi.mocked(fetchGithubRepoMeta).mockClear();
  vi.mocked(fetchGithubRepoMeta).mockResolvedValue({ id: 42, html_url: 'https://github.com/Papercusp/blueprints' } as never);
  vi.mocked(gitCloneShallow).mockClear();
  servedIds = ['coding', 'base'];
  clonedTo.length = 0;
  prepareSaw.length = 0;
});

describe('POST /cupboard/publish-blueprint — signs the SERVED bytes (WI-10001750 / EI-23992492696259433)', () => {
  it('prepares the release from a clone of github_url through the install seam, not from the local copy', async () => {
    const res = await post({ id: 'coding', github_url: 'https://github.com/Papercusp/blueprints' });
    expect(res.status).toBe(200);
    expect(gitCloneShallow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gitCloneShallow).mock.calls[0][0]).toBe('https://github.com/Papercusp/blueprints');
    const clone = clonedTo[0];
    expect(prepareSaw).toHaveLength(1);
    // The blueprint signed is the one the listing serves...
    expect(prepareSaw[0].blueprintFile).toBe(join(clone, 'coding', 'blueprint.yaml'));
    expect(prepareSaw[0].blueprintFile).not.toBe(bpPath.coding);
    expect(prepareSaw[0].blueprintExists).toBe(true);
    // ...and its `extends` parent resolves to the SERVED base, not the host's.
    expect(prepareSaw[0].base).toBe(join(clone, 'base', 'blueprint.yaml'));
    expect(prepareSaw[0].base).not.toBe(bpPath.base);
    // The scratch clone never outlives the request.
    expect(existsSync(clone)).toBe(false);
  });

  it('refuses to sign (422, nothing published) when the served repo does not carry the listing ref', async () => {
    servedIds = ['base'];
    const res = await post({ id: 'coding', github_url: 'https://github.com/Papercusp/blueprints' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('blueprint_release_invalid');
    expect(prepareSaw).toHaveLength(0);
    expect(publishListingToCupboard).not.toHaveBeenCalled();
    expect(existsSync(clonedTo[0])).toBe(false);
  });

  it('never clones for a blueprint the visibility gate refuses', async () => {
    const res = await post({ id: 'audit', github_url: 'https://github.com/Papercusp/blueprints' });
    expect(res.status).toBe(422);
    expect(gitCloneShallow).not.toHaveBeenCalled();
  });
});

describe('POST /cupboard/publish-blueprint — public-visibility gate (P-002)', () => {
  it('422s an unmarked (internal-by-default) blueprint before any GitHub call or publish', async () => {
    const res = await post({ id: 'audit', github_url: 'https://github.com/Papercusp/blueprints' });
    expect(res.status).toBe(422);
    expect(String((await res.json()).error)).toContain('visibility: public');
    expect(fetchGithubRepoMeta).not.toHaveBeenCalled();
    expect(publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('422s a blueprint explicitly marked visibility: internal', async () => {
    const res = await post({ id: 'papercup', github_url: 'https://github.com/Papercusp/blueprints' });
    expect(res.status).toBe(422);
    expect(publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('publishes a blueprint explicitly marked visibility: public as listing_kind=blueprint', async () => {
    const res = await post({ id: 'coding', github_url: 'https://github.com/Papercusp/blueprints' });
    expect(res.status).toBe(200);
    expect(publishListingToCupboard).toHaveBeenCalledWith(
      expect.objectContaining({
        listing_kind: 'blueprint',
        listing_ref: 'coding',
        release: expect.objectContaining({ visibility: 'public' }),
      }),
    );
  });

  it('still 404s a blueprint the operator cannot resolve (gate does not mask not-found)', async () => {
    const res = await post({ id: 'does-not-exist', github_url: 'https://github.com/Papercusp/blueprints' });
    expect(res.status).toBe(404);
    expect(publishListingToCupboard).not.toHaveBeenCalled();
  });
});
