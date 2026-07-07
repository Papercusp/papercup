/**
 * Coverage for the local template store (local-first-party-template-bundling-2026-07-07)
 * — the offline data layer behind the LOCAL half of templates:*. Hermetic: fixture
 * template dirs on disk, roots injected (no PAPERCUSP_TEMPLATES_DIR / no network).
 * Exercises: layered enumeration + user-shadows-bundled, template.yaml fallback when
 * listing.json is absent (the v2-installed shape), ref/id resolution, GUIDE read, and
 * the TemplateListing normalization.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listLocalTemplates,
  resolveLocalTemplate,
  readLocalGuide,
  toTemplateListing,
  type TemplateRoot,
} from './template-store';

let scratch: string;
let bundled: string;
let user: string;
let roots: TemplateRoot[];

function writeTemplate(
  root: string,
  ref: string,
  opts: { listing?: object; yaml?: string; guide?: string; catalog?: string } = {},
): string {
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  if (opts.listing !== undefined) writeFileSync(join(dir, 'listing.json'), JSON.stringify(opts.listing));
  if (opts.yaml !== undefined) writeFileSync(join(dir, 'template.yaml'), opts.yaml);
  if (opts.guide !== undefined) writeFileSync(join(dir, 'GUIDE.md'), opts.guide);
  if (opts.catalog !== undefined) writeFileSync(join(dir, 'COMPONENT_CATALOG.md'), opts.catalog);
  return dir;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tstore-'));
  bundled = join(scratch, 'bundled');
  user = join(scratch, 'user');
  mkdirSync(bundled, { recursive: true });
  mkdirSync(user, { recursive: true });
  roots = [
    { dir: bundled, layer: 'bundled' },
    { dir: user, layer: 'user' },
  ];
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe('listLocalTemplates', () => {
  it('enumerates self-describing dirs, skips non-templates, sorts by ref', () => {
    writeTemplate(bundled, 'papercusp-webapp', {
      listing: {
        ref: 'papercusp-webapp',
        id: 'papercusp-webapp',
        title: 'Web App',
        description: 'd',
        category: 'app',
        scope: 'app',
        version: '0.1.0',
        source: 'first-party',
      },
      yaml: 'id: papercusp-webapp\nscope: app\ncategory: app\n',
      guide: '# g',
    });
    writeTemplate(bundled, 'papercusp-ui', {
      listing: { ref: 'papercusp-ui', title: 'UI', category: 'ui', scope: 'aspect' },
      yaml: 'id: papercusp-ui\n',
      guide: '# g',
    });
    writeFileSync(join(bundled, 'README.md'), '# not a template'); // skipped (not a dir)
    mkdirSync(join(bundled, 'empty-dir')); // skipped (no manifest/listing)

    const all = listLocalTemplates(roots);
    expect(all.map((t) => t.ref)).toEqual(['papercusp-ui', 'papercusp-webapp']);
    expect(all.find((t) => t.ref === 'papercusp-webapp')).toMatchObject({
      title: 'Web App',
      category: 'app',
      scope: 'app',
      layer: 'bundled',
      source: 'first-party',
    });
  });

  it('a user-layer ref shadows a bundled one (the v2 install-over-first-party seam)', () => {
    writeTemplate(bundled, 'papercusp-webapp', {
      listing: { ref: 'papercusp-webapp', title: 'Bundled Web' },
      yaml: 'id: papercusp-webapp\n',
    });
    writeTemplate(user, 'papercusp-webapp', {
      listing: { ref: 'papercusp-webapp', title: 'Installed Web', source: 'installed' },
      yaml: 'id: papercusp-webapp\n',
    });
    const all = listLocalTemplates(roots);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: 'Installed Web', layer: 'user', source: 'installed' });
  });

  it('falls back to template.yaml scalars when listing.json is absent (v2-installed dir)', () => {
    writeTemplate(user, 'papercusp-search', {
      yaml: 'id: papercusp-search\nscope: aspect\ncategory: search\nversion: "0.2.0"\n',
      guide: '# g',
    });
    expect(listLocalTemplates(roots)[0]).toMatchObject({
      ref: 'papercusp-search',
      id: 'papercusp-search',
      category: 'search',
      scope: 'aspect',
      version: '0.2.0',
      source: 'installed',
      title: 'papercusp-search',
    });
  });
});

describe('resolveLocalTemplate', () => {
  it('resolves by ref and by id, null on miss', () => {
    writeTemplate(bundled, 'papercusp-webapp', {
      listing: { ref: 'papercusp-webapp', id: 'uuid-1', title: 'Web' },
      yaml: 'id: papercusp-webapp\n',
    });
    expect(resolveLocalTemplate('papercusp-webapp', roots)?.title).toBe('Web');
    expect(resolveLocalTemplate('uuid-1', roots)?.ref).toBe('papercusp-webapp');
    expect(resolveLocalTemplate('nope', roots)).toBeNull();
  });
});

describe('readLocalGuide', () => {
  it('reads GUIDE + catalog + manifest with branch=local', () => {
    const dir = writeTemplate(bundled, 'papercusp-webapp', {
      guide: '# Build\nMUST x',
      catalog: '# comps',
      yaml: 'id: papercusp-webapp\n',
    });
    const g = readLocalGuide({ ref: 'papercusp-webapp', dir });
    expect('error' in g).toBe(false);
    if (!('error' in g)) {
      expect(g.branch).toBe('local');
      expect(g.guide).toContain('MUST x');
      expect(g.componentCatalog).toBe('# comps');
      expect(g.manifest).toContain('id: papercusp-webapp');
      expect(g.fetchedFiles).toEqual(
        expect.arrayContaining(['GUIDE.md', 'COMPONENT_CATALOG.md', 'template.yaml']),
      );
    }
  });

  it('404 when GUIDE.md is absent', () => {
    const dir = writeTemplate(bundled, 'papercusp-webapp', { yaml: 'id: papercusp-webapp\n' });
    expect(readLocalGuide({ ref: 'papercusp-webapp', dir })).toMatchObject({ status: 404 });
  });
});

describe('toTemplateListing', () => {
  it('normalizes to the TemplateListing shape (empty githubUrl, official review)', () => {
    writeTemplate(bundled, 'papercusp-webapp', {
      listing: {
        ref: 'papercusp-webapp',
        id: 'uuid',
        title: 'Web',
        description: 'd',
        category: 'app',
        scope: 'app',
        source: 'first-party',
      },
      yaml: 'id: papercusp-webapp\n',
    });
    const t = resolveLocalTemplate('papercusp-webapp', roots)!;
    expect(toTemplateListing(t)).toMatchObject({
      ref: 'papercusp-webapp',
      id: 'uuid',
      title: 'Web',
      githubUrl: '',
      category: 'app',
      scope: 'app',
      reviewStatus: 'official',
    });
  });
});
