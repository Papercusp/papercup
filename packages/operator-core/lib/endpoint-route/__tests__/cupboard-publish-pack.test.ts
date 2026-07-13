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
  it("a kind:'pack' manifest publishes as listing_kind='pack' (canonical, mig 010) with manifest-derived provides_tools", async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PACK_MANIFEST as never);
    const res = await post({ slug: 'markdown-tools' });
    expect(res.status).toBe(200);
    expect(publishListingToCupboard).toHaveBeenCalledWith(
      expect.objectContaining({
        // The manifest format uses kind:'pack'; the LISTING kind is the
        // canonical 'pack' (migration 010 renamed the interim 'tool-pack' — P-003).
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

  it('does NOT gate a pack publish (scoped to kind=plugin) — a null manifest still 200s', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PACK_MANIFEST as never); // kind:'pack' → pack
    vi.mocked(fetchGithubRepoFile).mockResolvedValue(null);
    const res = await post({ slug: 'markdown-tools' });
    expect(res.status).toBe(200);
    expect(fetchGithubRepoFile).not.toHaveBeenCalled();
    expect(publishListingToCupboard).toHaveBeenCalledWith(expect.objectContaining({ listing_kind: 'pack' }));
  });
});

/**
 * The EVENT axis on the publish path (cupboard-public-release P-008 / D-003).
 *
 * ⚠ THESE ARE THE REGRESSION TESTS FOR A REAL SHIPPED GAP. P-007 built the whole
 * event axis — the D1 column, the worker's accept+validate, the catalog read, the
 * resolver, the install gate — and NOTHING EVER WROTE provides_events, because no
 * publish path sent it. `cupboardEventIndex` was therefore permanently empty,
 * `resolveEventProvider` could never return 'installable', and an event dep could
 * never pull its providing unit in: the entire installable rung was INERT.
 *
 * It survived a green suite because the pack-catalog tests feed provides_events in
 * from a FIXTURE, bypassing publish entirely — the loop-core was tested, the real
 * path was not. So these tests deliberately sit AT the boundary that was blind:
 * they assert what the route SENDS to the publisher, not what a fixture contains.
 */
describe('POST /cupboard/publish-plugin — the event axis (P-008)', () => {
  const EVENT_MANIFEST = {
    ...PACK_MANIFEST,
    provides: {
      events: [
        { family: 'md:rendered', keyTemplate: 'md:rendered:<doc>', params: [{ name: 'doc' }], describe: 'a doc rendered' },
      ],
    },
    dependencies: {
      events: [{ family: 'fs:changed' }, { family: 'lint:done', optional: true }],
    },
  };

  it('SENDS the manifest\'s provides.events + dependencies.events with the listing', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(EVENT_MANIFEST as never);
    const res = await post({ slug: 'markdown-tools' });
    expect(res.status).toBe(200);
    expect(publishListingToCupboard).toHaveBeenCalledWith(
      expect.objectContaining({
        provides_events: [
          { family: 'md:rendered', keyTemplate: 'md:rendered:<doc>', describe: 'a doc rendered' },
        ],
        // A bare declaration is REQUIRED (optional:false); `optional:true` stays soft.
        requires_events: [
          { family: 'fs:changed', optional: false },
          { family: 'lint:done', optional: true },
        ],
      }),
    );
  });

  it('omits both fields entirely when the manifest declares no events (no empty arrays on the wire)', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue(PACK_MANIFEST as never); // no provides/dependencies
    const res = await post({ slug: 'markdown-tools' });
    expect(res.status).toBe(200);
    const sent = vi.mocked(publishListingToCupboard).mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('provides_events');
    expect(sent).not.toHaveProperty('requires_events');
  });

  it('422s a manifest whose provided family has no keyTemplate — LOUD, not silently dropped', async () => {
    // Fail-soft is right when READING a third party's manifest (one bad unit must
    // not break catalog derivation for everyone). It is wrong when PUBLISHING your
    // own: silently dropping a family the author believes they declared ships a
    // listing that lies about itself, and every awaiter of the advertised key
    // parks forever on a key nothing emits.
    vi.mocked(findInstalledPlugin).mockResolvedValue({
      ...PACK_MANIFEST,
      provides: { events: [{ family: 'md:rendered' }] }, // no keyTemplate
    } as never);
    const res = await post({ slug: 'markdown-tools' });
    expect(res.status).toBe(422);
    expect(publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('422s a manifest whose keyTemplate placeholder has no matching param', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue({
      ...PACK_MANIFEST,
      provides: { events: [{ family: 'md:rendered', keyTemplate: 'md:rendered:<doc>' }] }, // no params
    } as never);
    const res = await post({ slug: 'markdown-tools' });
    expect(res.status).toBe(422);
    expect(publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('422s a duplicate provided family (ambiguous "who provides X?" within one unit)', async () => {
    vi.mocked(findInstalledPlugin).mockResolvedValue({
      ...PACK_MANIFEST,
      provides: {
        events: [
          { family: 'md:rendered', keyTemplate: 'md:rendered' },
          { family: 'md:rendered', keyTemplate: 'md:other' },
        ],
      },
    } as never);
    const res = await post({ slug: 'markdown-tools' });
    expect(res.status).toBe(422);
    expect(publishListingToCupboard).not.toHaveBeenCalled();
  });

  it('is NOT body-overridable, unlike provides_tools — the manifest is the only authority', async () => {
    // A provided family carries a keyTemplate the RUNTIME is held to. Letting a
    // publisher hand-type it invites a listing promising `deploy:<env>` while the
    // code fires something else — and every awaiter of the advertised key hangs
    // forever. So a body value is ignored, not honoured.
    vi.mocked(findInstalledPlugin).mockResolvedValue(EVENT_MANIFEST as never);
    const res = await post({
      slug: 'markdown-tools',
      provides_events: [{ family: 'spoof:done', keyTemplate: 'spoof:done' }],
      requires_events: [{ family: 'spoof:need' }],
    });
    expect(res.status).toBe(200);
    expect(publishListingToCupboard).toHaveBeenCalledWith(
      expect.objectContaining({
        provides_events: [
          { family: 'md:rendered', keyTemplate: 'md:rendered:<doc>', describe: 'a doc rendered' },
        ],
        requires_events: [
          { family: 'fs:changed', optional: false },
          { family: 'lint:done', optional: true },
        ],
      }),
    );
  });
});
