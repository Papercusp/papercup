/**
 * pack-format + load-packs unit tests (learning-packs-2026-06-11 P-001).
 * The parser/validator is pure; the loader runs against a tmp-dir fixture.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compareSemver,
  filterByShapes,
  memoryTextOf,
  parseLearningFile,
  parsePackDocFile,
  OKF_VERSION,
  parseManifest,
  provenanceOf,
  semverGt,
  validatePack,
  type KnowledgePack,
} from './pack-format';
import { builtinKnowledgePacksRoot, listKnowledgePacks, loadKnowledgePack } from './load-packs';

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const { manifest, error } = parseManifest(
      ['id: coding', 'title: Generic coding', 'description: Core working wisdom.', 'version: 1.0.0', 'author: Papercusp'].join('\n'),
    );
    expect(error).toBeUndefined();
    expect(manifest).toEqual({
      id: 'coding',
      title: 'Generic coding',
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

  // okf-frontmatter-adoption-2026-08-08 P-004. parseManifest is a WHITELIST
  // constructor — it builds a fresh object from named keys — so a manifest key
  // it does not read is silently DROPPED, not rejected. These pin the read side
  // of the okf_version thread; without it the field on disk is decorative.
  describe('okf_version', () => {
    const base = 'id: ok\ntitle: t\ndescription: d\nversion: 1.0.0';

    it('is absent (not undefined-valued) when the manifest does not declare it', () => {
      const { manifest } = parseManifest(base);
      expect(manifest).toBeDefined();
      expect('okfVersion' in manifest!).toBe(false);
    });

    it('reads a quoted string', () => {
      expect(parseManifest(`${base}\nokf_version: "0.2"`).manifest?.okfVersion).toBe('0.2');
    });

    it('coerces the unquoted YAML NUMBER form', () => {
      // `okf_version: 0.2` parses as 0.2 (a number), not '0.2'. Callers compare
      // strings, so an un-coerced number would silently never match.
      expect(parseManifest(`${base}\nokf_version: 0.2`).manifest?.okfVersion).toBe('0.2');
    });

    it('accepts an UNKNOWN version rather than rejecting it', () => {
      // OKF's tolerate-unknown rule: a pack authored against a newer revision
      // must still load. Validating against a known set here would make every
      // future spec bump a hard load failure.
      const { manifest, error } = parseManifest(`${base}\nokf_version: "9.9"`);
      expect(error).toBeUndefined();
      expect(manifest?.okfVersion).toBe('9.9');
    });
  });
});

describe('builtin manifests declare okf_version (P-004)', () => {
  // The recurrence guard for the whole P-004 manifest leg: the codemod's write,
  // the parser's read and the on-disk files must agree. A manifest rewritten by
  // a path that drops the field (renderManifest is a full REWRITE, not a patch)
  // reds here rather than silently regressing the corpus to 0/3.
  it('every builtin pack manifest parses to okfVersion === OKF_VERSION', async () => {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = builtinKnowledgePacksRoot();
    const packs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    // "0 offenders" and "0 files examined" are the same output otherwise.
    expect(packs.length, `no pack dirs under ${root}`).toBeGreaterThan(0);

    for (const pack of packs) {
      const file = join(root, pack, 'manifest.yaml');
      if (!existsSync(file)) continue;
      const { manifest, error } = parseManifest(readFileSync(file, 'utf8'));
      expect(error, `${pack}/manifest.yaml`).toBeUndefined();
      expect(manifest?.okfVersion, `${pack}/manifest.yaml okf_version`).toBe(OKF_VERSION);
    }
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

describe('parsePackDocFile (P-009 / D-022)', () => {
  const file = (fm: string, body = 'Run the migration allocator before writing SQL.') =>
    `---\n${fm}\n---\n\n${body}\n`;

  it('parses with defaults (kind=recipe, id from filename) and keeps the body verbatim', () => {
    const { doc, error } = parsePackDocFile(file('title: Allocate migrations\nsection: Storage'), 'allocate-migrations');
    expect(error).toBeUndefined();
    expect(doc).toEqual({ id: 'allocate-migrations', title: 'Allocate migrations', section: 'Storage',
      kind: 'recipe', body: 'Run the migration allocator before writing SQL.' });
  });

  it('accepts an explicit id and a projecting kind', () => {
    expect(parsePackDocFile(file('id: never-guess\ntitle: t\nsection: S\nkind: invariant'), 'fallback').doc)
      .toMatchObject({ id: 'never-guess', kind: 'invariant' });
  });

  it('rejects a missing section/title, an empty body, and prose (it never projects)', () => {
    expect(parsePackDocFile(file('title: t'), 'x').error).toMatch(/section missing/);
    expect(parsePackDocFile(file('section: S'), 'x').error).toMatch(/title missing/);
    expect(parsePackDocFile('---\ntitle: t\nsection: S\n---\n\n', 'x').error).toMatch(/empty/);
    expect(parsePackDocFile(file('title: t\nsection: S\nkind: prose'), 'x').error).toMatch(/kind/);
    expect(parsePackDocFile(file('id: Not Kebab\ntitle: t\nsection: S'), 'x').error).toMatch(/kebab/);
    expect(parsePackDocFile('no frontmatter', 'x').error).toMatch(/frontmatter/);
  });
});

describe('validatePack + filterByShapes + provenance', () => {
  const pack: KnowledgePack = {
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

  it('a docs-only pack is valid; duplicate doc ids fail', () => {
    const doc = { id: 'd', title: 'D', section: 'S', kind: 'recipe' as const, body: 'b' };
    expect(validatePack({ ...pack, items: [], docs: [doc] })).toEqual([]);
    expect(validatePack({ ...pack, docs: [doc, doc] })).toEqual(['duplicate doc id: d']);
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
  const root = mkdtempSync(join(tmpdir(), 'knowledge-packs-'));
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

  writePack(builtin, 'coding', '1.0.0', { 'tests-ship': 'Tests ship with the feature' });
  writePack(installed, 'rails-pack', '2.1.0', { 'rails-a': 'A', 'rails-b': 'B' });
  // id clash: builtin must win
  writePack(installed, 'coding', '9.9.9', { shadow: 'Shadowed' });
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
    const packs = await listKnowledgePacks(roots);
    const ids = packs.map((p) => p.id).sort();
    expect(ids).toEqual(['coding', 'rails-pack']);
    const def = packs.find((p) => p.id === 'coding')!;
    expect(def.version).toBe('1.0.0');
    expect(def.source).toBe('builtin');
    expect(packs.find((p) => p.id === 'rails-pack')!.itemCount).toBe(2);
  });

  it('loads one pack by id; missing id → null', async () => {
    const loaded = await loadKnowledgePack('rails-pack', roots);
    expect(loaded?.pack.items.map((i) => i.id).sort()).toEqual(['rails-a', 'rails-b']);
    expect(loaded?.source).toBe('installed');
    expect(await loadKnowledgePack('nope', roots)).toBeNull();
  });

  it('absent roots are empty, not errors', async () => {
    expect(
      await listKnowledgePacks({ roots: [{ dir: join(root, 'missing'), source: 'builtin' }] }),
    ).toEqual([]);
  });

  it('loads docs/ items sorted by file, skips a bad one, and omits docs when a pack ships none', async () => {
    const docRoot = join(root, 'with-docs');
    writePack(docRoot, 'procedures', '1.0.0', {});
    const docs = join(docRoot, 'procedures', 'docs');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'b-second.md'), '---\ntitle: Second\nsection: Workflow\nkind: pointer\n---\n\nSee the runbook.\n');
    writeFileSync(join(docs, 'a-first.md'), '---\ntitle: First\nsection: Workflow\n---\n\nDo this first.\n');
    writeFileSync(join(docs, 'no-section.md'), '---\ntitle: Broken\n---\n\nMissing its section.\n');
    const loaded = await loadKnowledgePack('procedures', { roots: [{ dir: docRoot, source: 'installed' }] });
    expect(loaded?.pack.items).toEqual([]);
    expect(loaded?.pack.docs?.map((d) => [d.id, d.kind])).toEqual([['a-first', 'recipe'], ['b-second', 'pointer']]);
    expect(loaded?.warnings).toEqual(['procedures: docs/no-section: section missing']);
    const docless = await loadKnowledgePack('rails-pack', roots);
    expect(docless && 'docs' in docless.pack).toBe(false);
  });
});

describe('compareSemver / semverGt (LP-1: numeric, not string)', () => {
  it('orders by numeric component, not lexical string', () => {
    // The string-inequality bug: '1.10.0' !== '1.9.0' is true either way, but
    // '1.10.0' < '1.9.0' lexically — only numeric compare reads 1.10 > 1.9.
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
    expect(compareSemver('1.9.0', '1.10.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.0.0')).toBe(1);
    expect(compareSemver('0.0.10', '0.0.9')).toBe(1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('semverGt: catalog newer than installed → true; older/equal → false', () => {
    // installed 1.0.0, catalog 2.0.0 ⇒ update available.
    expect(semverGt('2.0.0', '1.0.0')).toBe(true);
    // installed 1.9.0, catalog 1.10.0 ⇒ update available (the string bug).
    expect(semverGt('1.10.0', '1.9.0')).toBe(true);
    // installed 2.0.0, catalog 1.0.0 ⇒ DOWNGRADE, NOT an update (string !== bug).
    expect(semverGt('1.0.0', '2.0.0')).toBe(false);
    // equal ⇒ not an update (string !== would also be false here — the safe case).
    expect(semverGt('1.0.0', '1.0.0')).toBe(false);
  });

  it('semverGt tolerates undefined / malformed versions (never spuriously true)', () => {
    expect(semverGt(undefined, '1.0.0')).toBe(false);
    expect(semverGt('1.0.0', undefined)).toBe(false);
    expect(semverGt('not-a-version', '1.0.0')).toBe(false);
    expect(semverGt('1.0.0', 'not-a-version')).toBe(true); // valid beats malformed
  });
});
