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
});

describe('POST /cupboard/publish-plugin — pack kind', () => {
  it("a kind:'pack' manifest publishes as listing_kind='pack' with manifest-derived provides_tools", async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PACK_MANIFEST as never);
    const res = await post({ slug: 'markdown-tools' });
    expect(res.status).toBe(200);
    expect(publishListingToCupboard).toHaveBeenCalledWith(
      expect.objectContaining({
        listing_kind: 'pack',
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
