/**
 * POST /cupboard/publish-plugin — pack-kind + provides_tools behavior
 * (tool-distribution-granularity-2026-06-05 P-005).
 *
 * The route publishes an installed distribution unit; these tests pin the
 * pack-model additions:
 *   - a manifest with kind:'pack' lists as listing_kind='pack';
 *   - provides_tools defaults to the manifest's tool names (loader naming
 *     convention) and an explicit body override wins;
 *   - a malformed provides_tools override 400s without hitting the publisher.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cupboard/plugin-listings', () => ({
  findInstalledPlugin: vi.fn(),
}));
vi.mock('../../cupboard/publish-listing', () => ({
  publishListingToCupboard: vi.fn(async () => ({ ok: true, status: 200, data: { id: 'lst-1' } })),
}));
vi.mock('../../cupboard/resolve-repo-coords', () => ({
  parseGithubRemote: vi.fn(),
  gitOriginUrl: vi.fn(),
  fetchGithubRepoMeta: vi.fn(),
  // The publish-time manifest gate (P-005) reads the backing repo's
  // papercusp.json; default it to a valid manifest so plugin publishes pass.
  fetchGithubRepoFile: vi.fn(async () => JSON.stringify({ name: 'markdown-tools', version: '0.1.0' })),
  resolveRepoCoordsFromDir: vi.fn(async () => ({
    github_repository_id: 7,
    github_owner: 'acme',
    github_name: 'tool-packs',
    github_url: 'https://github.com/acme/tool-packs',
  })),
}));

import route from '../routes/cupboard-publish-plugin';
import { findInstalledPlugin } from '../../cupboard/plugin-listings';
import { publishListingToCupboard } from '../../cupboard/publish-listing';
import { fetchGithubRepoFile } from '../../cupboard/resolve-repo-coords';

const PACK_MANIFEST = {
  name: 'markdown-tools',
  version: '0.1.0',
  description: 'Markdown helpers',
  kind: 'pack',
  source: 'global',
  path: '/tmp/plugins/markdown-tools',
  tools: [{ name: 'render' }, { name: 'lint' }],
};

function post(body: unknown): Promise<Response> {
  const req = new Request('http://localhost/cupboard/publish-plugin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (route as { handler: (req: Request) => Promise<Response> }).handler(req);
}

beforeEach(() => {
  vi.mocked(findInstalledPlugin).mockReset();
  vi.mocked(publishListingToCupboard).mockClear();
  vi.mocked(publishListingToCupboard).mockResolvedValue({ ok: true, status: 200, data: { id: 'lst-1' } });
  vi.mocked(fetchGithubRepoFile).mockReset();
  vi.mocked(fetchGithubRepoFile).mockResolvedValue(JSON.stringify({ name: 'markdown-tools', version: '0.1.0' }));
});

describe('POST /cupboard/publish-plugin — pack kind', () => {
  it("a kind:'pack' manifest publishes as listing_kind='tool-pack' (renamed by mig 008) with manifest-derived provides_tools", async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PACK_MANIFEST as never);
    const res = await post({ slug: 'markdown-tools' });
    expect(res.status).toBe(200);
    expect(publishListingToCupboard).toHaveBeenCalledWith(
      expect.objectContaining({
        // The manifest format keeps kind:'pack'; the LISTING kind is the
        // renamed 'tool-pack' (learning-packs D-005 / worker migration 008).
        listing_kind: 'tool-pack',
        listing_ref: 'markdown-tools',
        provides_tools: ['markdown-tools.render', 'markdown-tools.lint'],
      }),
    );
  });

  it('a plugin manifest still publishes as listing_kind=plugin (with its tools declared)', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue({
      ...PACK_MANIFEST,
      name: '@papercupai/repomix',
      kind: 'plugin',
      tools: [{ name: 'pack' }],
    } as never);
    const res = await post({ slug: '@papercupai/repomix' });
    expect(res.status).toBe(200);
    expect(publishListingToCupboard).toHaveBeenCalledWith(
      expect.objectContaining({ listing_kind: 'plugin', provides_tools: ['repomix.pack'] }),
    );
  });

  it('an explicit provides_tools override wins over the manifest', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PACK_MANIFEST as never);
    const res = await post({ slug: 'markdown-tools', provides_tools: ['md.custom'] });
    expect(res.status).toBe(200);
    expect(publishListingToCupboard).toHaveBeenCalledWith(
      expect.objectContaining({ provides_tools: ['md.custom'] }),
    );
  });

  it('a malformed provides_tools override 400s before publishing', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PACK_MANIFEST as never);
    for (const bad of ['nope', [], [''], [1], ['a'.repeat(129)]]) {
      const res = await post({ slug: 'markdown-tools', provides_tools: bad });
      expect(res.status, `shape: ${JSON.stringify(bad)}`).toBe(400);
    }
    expect(publishListingToCupboard).not.toHaveBeenCalled();
  });
});

describe('POST /cupboard/publish-plugin — publish-time manifest gate (P-005)', () => {
  const PLUGIN_MANIFEST = { ...PACK_MANIFEST, name: 'my-plugin', kind: 'plugin', tools: [{ name: 't' }] };

  it('422s a plugin publish when the backing repo has no papercusp.json (un-installable)', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PLUGIN_MANIFEST as never);
    vi.mocked(fetchGithubRepoFile).mockResolvedValue(null); // repo carries no manifest
    const res = await post({ slug: 'my-plugin' });
    expect(res.status).toBe(422);
    expect(String((await res.json()).error)).toContain('no installable papercusp.json');
    expect(publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('422s a plugin publish when the repo manifest lacks {name, version}', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PLUGIN_MANIFEST as never);
    vi.mocked(fetchGithubRepoFile).mockResolvedValue(JSON.stringify({ name: 'x' })); // no version
    const res = await post({ slug: 'my-plugin' });
    expect(res.status).toBe(422);
    expect(publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('publishes a plugin when the repo carries a valid papercusp.json', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PLUGIN_MANIFEST as never);
    vi.mocked(fetchGithubRepoFile).mockResolvedValue(JSON.stringify({ name: 'my-plugin', version: '1.2.3' }));
    const res = await post({ slug: 'my-plugin' });
    expect(res.status).toBe(200);
    expect(publishListingToCupboard).toHaveBeenCalledWith(expect.objectContaining({ listing_kind: 'plugin' }));
  });

  it('does NOT gate a tool-pack publish (scoped to kind=plugin) — a null manifest still 200s', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PACK_MANIFEST as never); // kind:'pack' → tool-pack
    vi.mocked(fetchGithubRepoFile).mockResolvedValue(null);
    const res = await post({ slug: 'markdown-tools' });
    expect(res.status).toBe(200);
    expect(fetchGithubRepoFile).not.toHaveBeenCalled();
    expect(publishListingToCupboard).toHaveBeenCalledWith(expect.objectContaining({ listing_kind: 'tool-pack' }));
  });
});
