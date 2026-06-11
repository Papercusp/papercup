/**
 * load-packs — fs resolution for Learning Packs (learning-packs-2026-06-11 P-001).
 *
 * Two roots, mirroring the blueprint distribution tiers
 * (installed-blueprints.ts):
 *
 *   builtin    libs/papercusp/packages/harness/learnings/<id>/   (ships with the app)
 *   installed  ~/.papercusp/learning-packs/<id>/                 (Comb-installed, P-017)
 *
 * Builtin wins on an id clash — a community pack can never shadow a
 * first-party one. Missing roots are simply empty (fresh installs have no
 * installed dir; test fixtures override both via opts.roots).
 *
 * All file reads are batched with Promise.all — never a serial fs loop
 * (performance anti-pattern A1).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { harnessPath } from '../harness-paths';
import { papercuspRoot } from '../papercusp-root';
import {
  parseLearningFile,
  parseManifest,
  validatePack,
  type LearningItem,
  type LearningPack,
  type LearningPackSource,
  type LearningPackSummary,
} from './pack-format';

export function builtinLearningPacksRoot(): string {
  return harnessPath('learnings');
}

export function installedLearningPacksRoot(): string {
  return join(papercuspRoot(), 'learning-packs');
}

export interface PackRoots {
  /** Resolution order; earlier roots win on id clash. Default builtin → installed. */
  roots?: Array<{ dir: string; source: LearningPackSource }>;
}

function defaultRoots(): Array<{ dir: string; source: LearningPackSource }> {
  return [
    { dir: builtinLearningPacksRoot(), source: 'builtin' },
    { dir: installedLearningPacksRoot(), source: 'installed' },
  ];
}

export interface LoadedLearningPack {
  pack: LearningPack;
  source: LearningPackSource;
  /** Per-item parse problems for a pack that still loaded (none ⇒ clean). */
  warnings: string[];
}

/**
 * Read one pack directory. Returns null when the dir has no readable
 * manifest; a manifest with malformed learnings still loads (the bad items
 * are dropped into `warnings`) so one typo'd file never hides a whole pack —
 * EXCEPT when validation fails outright (no items / dup ids), which returns
 * null with the reason in `errors`.
 */
async function readPackDir(
  dir: string,
  source: LearningPackSource,
): Promise<{ loaded?: LoadedLearningPack; errors: string[] }> {
  const errors: string[] = [];

  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(join(dir, 'manifest.yaml'), 'utf8');
  } catch {
    return { errors: [`${dir}: no readable manifest.yaml`] };
  }
  const { manifest, error: manifestError } = parseManifest(manifestRaw);
  if (!manifest) return { errors: [`${dir}: ${manifestError}`] };

  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return { errors: [`${dir}: unreadable pack directory`] };
  }

  const warnings: string[] = [];
  const reads = await Promise.all(
    entries.map(async (file) => {
      try {
        const raw = await fs.readFile(join(dir, file), 'utf8');
        return { file, raw };
      } catch {
        warnings.push(`${manifest.id}/${file}: unreadable`);
        return null;
      }
    }),
  );

  const items: LearningItem[] = [];
  for (const read of reads) {
    if (!read) continue;
    const stem = read.file.replace(/\.md$/, '');
    const { item, error } = parseLearningFile(read.raw, stem);
    if (item) items.push(item);
    else if (error) warnings.push(`${manifest.id}: ${error}`);
  }

  const pack: LearningPack = { manifest, items };
  const packErrors = validatePack(pack);
  if (packErrors.length > 0) {
    return { errors: packErrors.map((e) => `${manifest.id}: ${e}`) };
  }
  return { loaded: { pack, source, warnings }, errors };
}

/** Enumerate every resolvable pack across the roots (earlier root wins on id). */
export async function listLearningPacks(opts: PackRoots = {}): Promise<LearningPackSummary[]> {
  const roots = opts.roots ?? defaultRoots();
  const byId = new Map<string, LearningPackSummary>();

  for (const { dir, source } of roots) {
    let subdirs: string[] = [];
    try {
      subdirs = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      continue; // root absent — fine (fresh install)
    }
    const loadedAll = await Promise.all(
      subdirs.map((name) => readPackDir(join(dir, name), source)),
    );
    for (const { loaded } of loadedAll) {
      if (!loaded) continue;
      const m = loaded.pack.manifest;
      if (byId.has(m.id)) continue; // earlier root wins
      byId.set(m.id, {
        id: m.id,
        title: m.title,
        description: m.description,
        version: m.version,
        ...(m.author ? { author: m.author } : {}),
        itemCount: loaded.pack.items.length,
        source,
      });
    }
  }
  return [...byId.values()];
}

/** Resolve one pack by id across the roots (earlier root wins). */
export async function loadLearningPack(
  packId: string,
  opts: PackRoots = {},
): Promise<LoadedLearningPack | null> {
  const roots = opts.roots ?? defaultRoots();
  for (const { dir, source } of roots) {
    const { loaded } = await readPackDir(join(dir, packId), source);
    if (loaded && loaded.pack.manifest.id === packId) return loaded;
  }
  return null;
}
