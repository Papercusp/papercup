/**
 * load-packs — fs resolution for Knowledge Packs (learning-packs-2026-06-11 P-001).
 *
 * Two roots, mirroring the blueprint distribution tiers
 * (installed-blueprints.ts):
 *
 *   builtin    libs/papercusp/packages/harness/knowledge-packs/<id>/  (ships with the app)
 *   installed  ~/.papercusp/knowledge-packs/<id>/                     (Comb-installed, P-017)
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
  type KnowledgePack,
  type KnowledgePackSource,
  type KnowledgePackSummary,
} from './pack-format';

export function builtinKnowledgePacksRoot(): string {
  // knowledge-packs P-003: the builtin dir was renamed harness/learnings →
  // harness/knowledge-packs alongside the module. It ships INSIDE the app
  // bundle, so there is no on-disk legacy copy to fall back to — a stale name
  // here is a hard "no builtin packs", not a soft miss.
  return harnessPath('knowledge-packs');
}

export function installedKnowledgePacksRoot(): string {
  return join(papercuspRoot(), 'knowledge-packs');
}

/**
 * The pre-rename installed root. Unlike the builtin dir this one lives in the
 * USER's home (`~/.papercusp/`), so an existing install genuinely has packs
 * sitting under the old name — they are migrated on boot (migrateInstalledRoot).
 */
export function legacyInstalledKnowledgePacksRoot(): string {
  return join(papercuspRoot(), 'learning-packs');
}

/**
 * Boot-time move of the installed-packs root (knowledge-packs P-003).
 *
 * D-001 is a HARD rename with no read-time aliases, so the old directory must
 * actually MOVE rather than be dual-read forever. Idempotent and fail-soft:
 * a missing legacy dir is the normal (fresh-install) case, and if BOTH exist
 * the new root wins and the legacy dir is left alone for the owner to inspect
 * rather than silently merged (a merge could shadow an installed pack with a
 * stale same-id copy).
 */
export async function migrateInstalledRoot(): Promise<
  { moved: false; reason: 'no-legacy' | 'already-migrated' } | { moved: true; from: string; to: string }
> {
  const legacy = legacyInstalledKnowledgePacksRoot();
  const next = installedKnowledgePacksRoot();
  const exists = async (d: string) => !!(await fs.stat(d).catch(() => null));

  if (!(await exists(legacy))) return { moved: false, reason: 'no-legacy' };
  if (await exists(next)) return { moved: false, reason: 'already-migrated' };

  await fs.rename(legacy, next);
  return { moved: true, from: legacy, to: next };
}

export interface PackRoots {
  /** Resolution order; earlier roots win on id clash. Default builtin → installed. */
  roots?: Array<{ dir: string; source: KnowledgePackSource }>;
}

function defaultRoots(): Array<{ dir: string; source: KnowledgePackSource }> {
  return [
    { dir: builtinKnowledgePacksRoot(), source: 'builtin' },
    { dir: installedKnowledgePacksRoot(), source: 'installed' },
  ];
}

export interface LoadedKnowledgePack {
  pack: KnowledgePack;
  source: KnowledgePackSource;
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
  source: KnowledgePackSource,
): Promise<{ loaded?: LoadedKnowledgePack; errors: string[] }> {
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

  const pack: KnowledgePack = { manifest, items };
  const packErrors = validatePack(pack);
  if (packErrors.length > 0) {
    return { errors: packErrors.map((e) => `${manifest.id}: ${e}`) };
  }
  return { loaded: { pack, source, warnings }, errors };
}

/** Enumerate every resolvable pack across the roots (earlier root wins on id). */
export async function listKnowledgePacks(opts: PackRoots = {}): Promise<KnowledgePackSummary[]> {
  const roots = opts.roots ?? defaultRoots();
  const byId = new Map<string, KnowledgePackSummary>();

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
export async function loadKnowledgePack(
  packId: string,
  opts: PackRoots = {},
): Promise<LoadedKnowledgePack | null> {
  const roots = opts.roots ?? defaultRoots();
  for (const { dir, source } of roots) {
    const { loaded } = await readPackDir(join(dir, packId), source);
    if (loaded && loaded.pack.manifest.id === packId) return loaded;
  }
  return null;
}

/**
 * Read + validate one pack DIRECTORY directly (no root resolution) — the
 * fetch-from-Comb path (P-017) validates a cloned repo's pack dir before
 * copying it under the installed root. Returns null + errors when invalid.
 */
export async function loadKnowledgePackFromDir(
  dir: string,
): Promise<{ loaded?: LoadedKnowledgePack; errors: string[] }> {
  return readPackDir(dir, 'installed');
}
