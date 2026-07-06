/**
 * Coverage for the Cupboard app-template read helpers (WI-3198) — the data layer
 * behind templates:list / templates:get-guide. resolveCupboardBaseUrl is mocked to
 * a fixed origin and fetch is stubbed, so this is hermetic (mirrors
 * plugin-listings.test.ts). Exercises: listing normalization, unreachable → not
 * "empty", resolve-by-id + resolve-by-ref + kind-checking, and the GUIDE fetch
 * (raw-URL derivation, main→master fallback, truncation, safe-ref guard).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./base-url', () => ({
  resolveCupboardBaseUrl: () => 'https://cupboard.test',
}));

import {
  fetchCupboardTemplates,
  resolveTemplateListing,
  fetchTemplateGuide,
  rawBaseFromGithub,
} from './templates';

const originalFetch = global.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  vi.stubEnv('PAPERCUSP_CUPBOARD_URL', 'https://cupboard.test');
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const text = (body: string, status = 200) => new Response(body, { status });

const WEBAPP = {
  id: 'be19a787-93f0-46ae-8f4d-85d728b7131b',
  listing_kind: 'template',
  listing_ref: 'papercusp-webapp',
  title: 'Papercusp Official: Web App',
  description: 'A whole web app',
  github_url: 'https://github.com/Papercusp/templates',
};

describe('fetchCupboardTemplates', () => {
  it('GETs /listings?kind=template and normalizes rows', async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [WEBAPP] }));
    const r = await fetchCupboardTemplates({ q: 'web' });
    expect(r.reachable).toBe(true);
    expect(r.templates).toHaveLength(1);
    expect(r.templates[0]).toMatchObject({
      id: WEBAPP.id,
      ref: 'papercusp-webapp',
      title: 'Papercusp Official: Web App',
      githubUrl: 'https://github.com/Papercusp/templates',
    });
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/listings');
    expect(calledUrl).toContain('kind=template');
    expect(calledUrl).toContain('q=web');
  });

  it('reports reachable:false (NOT empty) on a non-2xx upstream', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'boom' }, 500));
    const r = await fetchCupboardTemplates();
    expect(r).toEqual({ reachable: false, templates: [] });
  });

  it('reports reachable:false when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const r = await fetchCupboardTemplates();
    expect(r).toEqual({ reachable: false, templates: [] });
  });

  it('drops rows with neither id nor ref', async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [WEBAPP, { title: 'junk' }] }));
    const r = await fetchCupboardTemplates();
    expect(r.templates).toHaveLength(1);
  });
});

describe('resolveTemplateListing', () => {
  it('resolves by listing id via the detail endpoint', async () => {
    fetchMock.mockResolvedValueOnce(json(WEBAPP));
    const r = await resolveTemplateListing(WEBAPP.id);
    expect('error' in r).toBe(false);
    expect((r as { ref: string }).ref).toBe('papercusp-webapp');
  });

  it('rejects a non-template listing (kind-checked)', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...WEBAPP, listing_kind: 'blueprint' }));
    const r = await resolveTemplateListing(WEBAPP.id);
    expect(r).toMatchObject({ status: 422 });
  });

  it('falls back to a kind=template scan when detail 404s (resolve by ref)', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'not_found' }, 404)) // detail-by-ref misses
      .mockResolvedValueOnce(json({ results: [WEBAPP] })); // the scan finds it
    const r = await resolveTemplateListing('papercusp-webapp');
    expect('error' in r).toBe(false);
    expect((r as { id: string }).id).toBe(WEBAPP.id);
  });

  it('returns 404 when the ref is unknown', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'not_found' }, 404))
      .mockResolvedValueOnce(json({ results: [WEBAPP] }));
    const r = await resolveTemplateListing('no-such-template');
    expect(r).toMatchObject({ status: 404 });
  });

  it('returns 503 cupboard_unreachable when the scan cannot reach the Cupboard', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'x' }, 404)) // detail miss
      .mockResolvedValueOnce(json({ error: 'down' }, 500)); // scan unreachable
    const r = await resolveTemplateListing('papercusp-webapp');
    expect(r).toMatchObject({ status: 503, error: 'cupboard_unreachable' });
  });
});

describe('rawBaseFromGithub', () => {
  it('derives the raw.githubusercontent base (with and without .git)', () => {
    expect(rawBaseFromGithub('https://github.com/Papercusp/templates')).toBe(
      'https://raw.githubusercontent.com/Papercusp/templates',
    );
    expect(rawBaseFromGithub('https://github.com/Papercusp/templates.git')).toBe(
      'https://raw.githubusercontent.com/Papercusp/templates',
    );
  });
  it('returns null for a non-github url', () => {
    expect(rawBaseFromGithub('https://gitlab.com/x/y')).toBeNull();
  });
});

describe('fetchTemplateGuide', () => {
  const t = { githubUrl: 'https://github.com/Papercusp/templates', ref: 'papercusp-webapp' };

  it('fetches GUIDE.md + catalog + manifest from main', async () => {
    fetchMock
      .mockResolvedValueOnce(text('# GUIDE\nbuild it')) // GUIDE.md @ main
      .mockResolvedValueOnce(text('# components')) // COMPONENT_CATALOG.md
      .mockResolvedValueOnce(text('id: papercusp-webapp')) // template.yaml
      .mockResolvedValueOnce(text('', 404)); // template.yml (absent)
    const r = await fetchTemplateGuide(t);
    expect('error' in r).toBe(false);
    const g = r as import('./templates').TemplateGuide;
    expect(g.branch).toBe('main');
    expect(g.guide).toContain('build it');
    expect(g.componentCatalog).toContain('components');
    expect(g.manifest).toContain('papercusp-webapp');
    expect(g.fetchedFiles).toContain('template.yaml');
  });

  it('falls back to master when GUIDE.md is absent on main', async () => {
    fetchMock
      .mockResolvedValueOnce(text('', 404)) // GUIDE.md @ main → miss
      .mockResolvedValueOnce(text('# GUIDE master')) // GUIDE.md @ master
      .mockResolvedValueOnce(text('', 404)) // catalog
      .mockResolvedValueOnce(text('', 404)) // template.yaml
      .mockResolvedValueOnce(text('', 404)); // template.yml
    const r = await fetchTemplateGuide(t);
    expect((r as import('./templates').TemplateGuide).branch).toBe('master');
  });

  it('404s when GUIDE.md is on neither branch', async () => {
    fetchMock.mockResolvedValue(text('', 404));
    const r = await fetchTemplateGuide(t);
    expect(r).toMatchObject({ status: 404 });
  });

  it('rejects an unsafe ref before any fetch', async () => {
    const r = await fetchTemplateGuide({ githubUrl: t.githubUrl, ref: '../etc/passwd' });
    expect(r).toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
