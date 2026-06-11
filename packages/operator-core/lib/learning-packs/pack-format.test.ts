/**
 * pack-format + load-packs unit tests (learning-packs-2026-06-11 P-001).
 * The parser/validator is pure; the loader runs against a tmp-dir fixture.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  filterByShapes,
  memoryTextOf,
  parseLearningFile,
  parseManifest,
  provenanceOf,
  validatePack,
  type LearningPack,
} from './pack-format';
import { listLearningPacks, loadLearningPack } from './load-packs';

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const { manifest, error } = parseManifest(
      ['id: papercusp-default', 'title: Papercusp default', 'description: Core working wisdom.', 'version: 1.0.0', 'author: Papercusp'].join('\n'),
    );
    expect(error).toBeUndefined();
    expect(manifest).toEqual({
      id: 'papercusp-default',
      title: 'Papercusp default',
      description: 'Core working wisdom.',
      version: '1.0.0',
      author: 'Papercusp',
    });
  });

  it('rejects a non-kebab id', () => {
    expect(parseManifest('id: Bad Id\ntitle: t\ndescription: d\nversion: 1.0.0').error).toMatch(/kebab/);
  });

  it('rejects a non-semver version', () => {
    expect(parseManifest('id: ok\ntitle: t\ndescription: d\nversion: v1').error).toMatch(/semver/);
  });

  it('rejects non-mapping yaml', () => {
    expect(parseManifest('- a\n- b').error).toMatch(/mapping/);
  });
});

describe('parseLearningFile', () => {
  const file = (fm: string, body = 'Find how this project runs tests; use that framework.') =>
    `---\n${fm}\n---\n\n${body}\n`;

  it('parses with defaults (kind=feedback, applies_to=[any], id from filename)', () => {
    const { item, error } = parseLearningFile(file('title: Use the existing test framework'), 'use-existing-tests');
    expect(error).toBeUndefined();
    expect(item).toMatchObject({
      id: 'use-existing-tests',
      title: 'Use the existing test framework',
      kind: 'feedback',
      appliesTo: ['any'],
    });
    expect(item!.text).toContain('runs tests');
  });

  it('parses explicit kind + applies_to array', () => {
    const { item } = parseLearningFile(
      file('id: design-system-first\ntitle: Reuse the design system\nkind: feedback\napplies_to: [ui]'),
      'fallback',
    );
    expect(item).toMatchObject({ id: 'design-system-first', appliesTo: ['ui'] });
  });

  it('rejects missing title, empty body, bad kind, bad shape', () => {
    expect(parseLearningFile(file('kind: feedback'), 'x').error).toMatch(/title/);
    expect(parseLearningFile('---\ntitle: t\n---\n\n', 'x').error).toMatch(/empty/);
    expect(parseLearningFile(file('title: t\nkind: vibes'), 'x').error).toMatch(/kind/);
    expect(parseLearningFile(file('title: t\napplies_to: [desktop]'), 'x').error).toMatch(/applies_to/);
    expect(parseLearningFile('no frontmatter', 'x').error).toMatch(/frontmatter/);
  });
});

describe('validatePack + filterByShapes + provenance', () => {
  const pack: LearningPack = {
    manifest: { id: 'p', title: 'P', description: 'd', version: '1.2.0' },
    items: [
      { id: 'a', title: 'A', kind: 'feedback', appliesTo: ['any'], text: 'a' },
      { id: 'b', title: 'B', kind: 'feedback', appliesTo: ['ui'], text: 'b' },
      { id: 'c', title: 'C', kind: 'reference', appliesTo: ['cli', 'library'], text: 'c' },
    ],
  };

  it('valid pack passes; dup ids and empty packs fail', () => {
    expect(validatePack(pack)).toEqual([]);
    expect(validatePack({ ...pack, items: [...pack.items, pack.items[0]] })[0]).toMatch(/duplicate/);
    expect(validatePack({ ...pack, items: [] })[0]).toMatch(/no learnings/);
  });

  it('repo-less (no shapes) seeds any-only; shapes add matching items', () => {
    expect(filterByShapes(pack.items).map((i) => i.id)).toEqual(['a']);
    expect(filterByShapes(pack.items, ['ui']).map((i) => i.id)).toEqual(['a', 'b']);
    expect(filterByShapes(pack.items, ['cli']).map((i) => i.id)).toEqual(['a', 'c']);
    expect(filterByShapes(pack.items, ['service']).map((i) => i.id)).toEqual(['a']);
  });

  it('memoryTextOf is the canonical render; provenanceOf stamps pack coords', () => {
    expect(memoryTextOf(pack.items[1])).toBe('B — b');
    expect(provenanceOf(pack, pack.items[2])).toEqual({
      source: 'pack',
      pack_id: 'p',
      pack_version: '1.2.0',
      pack_item_id: 'c',
    });
  });
});

describe('load-packs (tmp fixture roots)', () => {
  const root = mkdtempSync(join(tmpdir(), 'learning-packs-'));
  const builtin = join(root, 'builtin');
  const installed = join(root, 'installed');

  const writePack = (base: string, id: string, version: string, items: Record<string, string>) => {
    const dir = join(base, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.yaml'),
      `id: ${id}\ntitle: ${id} title\ndescription: ${id} desc\nversion: ${version}\n`,
    );
    for (const [item, title] of Object.entries(items)) {
      writeFileSync(join(dir, `${item}.md`), `---\ntitle: ${title}\n---\n\nBody of ${item}.\n`);
    }
  };

  writePack(builtin, 'papercusp-default', '1.0.0', { 'tests-ship': 'Tests ship with the feature' });
  writePack(installed, 'rails-pack', '2.1.0', { 'rails-a': 'A', 'rails-b': 'B' });
  // id clash: builtin must win
  writePack(installed, 'papercusp-default', '9.9.9', { shadow: 'Shadowed' });
  // malformed pack (no items) must be skipped, not crash the listing
  mkdirSync(join(installed, 'broken'), { recursive: true });
  writeFileSync(join(installed, 'broken', 'manifest.yaml'), 'id: broken\ntitle: t\ndescription: d\nversion: 1.0.0\n');

  const roots = {
    roots: [
      { dir: builtin, source: 'builtin' as const },
      { dir: installed, source: 'installed' as const },
    ],
  };

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists across roots, builtin wins on clash, broken pack skipped', async () => {
    const packs = await listLearningPacks(roots);
    const ids = packs.map((p) => p.id).sort();
    expect(ids).toEqual(['papercusp-default', 'rails-pack']);
    const def = packs.find((p) => p.id === 'papercusp-default')!;
    expect(def.version).toBe('1.0.0');
    expect(def.source).toBe('builtin');
    expect(packs.find((p) => p.id === 'rails-pack')!.itemCount).toBe(2);
  });

  it('loads one pack by id; missing id → null', async () => {
    const loaded = await loadLearningPack('rails-pack', roots);
    expect(loaded?.pack.items.map((i) => i.id).sort()).toEqual(['rails-a', 'rails-b']);
    expect(loaded?.source).toBe('installed');
    expect(await loadLearningPack('nope', roots)).toBeNull();
  });

  it('absent roots are empty, not errors', async () => {
    expect(
      await listLearningPacks({ roots: [{ dir: join(root, 'missing'), source: 'builtin' }] }),
    ).toEqual([]);
  });
});
