/**
 * pack-format — the Learning Pack format: types + pure parse/validate/filter
 * (learning-packs-2026-06-11 P-001).
 *
 * A learning pack is a versioned, git-canonical set of *learnings* — curated,
 * project-transferable working wisdom seeded into a hive's own mem0 store at
 * creation/install (copy, never live-link — D-001). On disk a pack is:
 *
 *   <pack-dir>/
 *     manifest.yaml          { id, title, description, version, author? }
 *     <item-id>.md           one learning per file:
 *                            --- frontmatter: id?, title, kind?, applies_to? ---
 *                            body = the learning text
 *
 * Built-in packs live next to the blueprints they ship with
 * (`libs/papercusp/packages/harness/learnings/`); Comb-installed packs land
 * under `~/.papercusp/learning-packs/` (see ./load-packs).
 *
 * Content doctrine (D-002): learnings carry invariant judgment as DISCOVERY
 * RULES ("find how this project runs tests"), never stack bindings ("use
 * Vitest"); `applies_to` tags filter what seeds by project shape.
 *
 * This module is PURE — no fs, no PG, no network — so the parser/validator
 * pins hard in unit tests; IO lives in ./load-packs and ./seed.
 */

import { parse as parseYaml } from 'yaml';
import { parseFrontmatter } from '../memory/insights-index';

/** The pack preselected in the hive-creation picker (D-004). */
export const DEFAULT_LEARNING_PACK_ID = 'papercusp-default';

/**
 * Project shapes a learning can apply to (D-002/D-008). `any` always seeds;
 * the rest seed only when blueprint detection reports a matching shape.
 * Repo-less hives (no detection) seed `any`-tagged items only (OQ-3 → D-008).
 */
export const APPLIES_TO_SHAPES = ['ui', 'service', 'library', 'cli', 'any'] as const;
export type AppliesTo = (typeof APPLIES_TO_SHAPES)[number];

/** Mirrors memory:remember's KINDS — a seeded learning is an ordinary memory row. */
export const LEARNING_KINDS = ['user', 'feedback', 'project', 'reference'] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

/** Provenance metadata value marking a memory row as pack-seeded (D-001). */
export const PACK_MEMORY_SOURCE = 'pack';

export interface LearningPackManifest {
  /** Kebab-case pack id — globally unique (Comb listing_ref for published packs). */
  id: string;
  title: string;
  description: string;
  /** Three-part semver. Stamped on every seeded row for upgrade-diff (P-013). */
  version: string;
  author?: string;
}

export interface LearningItem {
  /** Kebab-case, unique within the pack. Defaults from the filename stem. */
  id: string;
  /** One-line human title — prefixed onto the memory text on seed. */
  title: string;
  /** memory kind for the seeded row. Default 'feedback' (how-to-work wisdom). */
  kind: LearningKind;
  /** Project shapes this learning seeds for. Default ['any']. */
  appliesTo: AppliesTo[];
  /** The learning body (markdown; stored verbatim as the memory text). */
  text: string;
}

export interface LearningPack {
  manifest: LearningPackManifest;
  items: LearningItem[];
}

/** Where a pack was resolved from (./load-packs). */
export type LearningPackSource = 'builtin' | 'installed';

export interface LearningPackSummary {
  id: string;
  title: string;
  description: string;
  version: string;
  author?: string;
  itemCount: number;
  source: LearningPackSource;
}

const KEBAB_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function isKebab(s: unknown): s is string {
  return typeof s === 'string' && KEBAB_RE.test(s);
}

/* ────────────────────────────────────────────────────────────────────────
 * Manifest
 * ──────────────────────────────────────────────────────────────────────── */

export function parseManifest(raw: string): { manifest?: LearningPackManifest; error?: string } {
  let obj: unknown;
  try {
    obj = parseYaml(raw);
  } catch (e) {
    return { error: `manifest.yaml parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: 'manifest.yaml must be a YAML mapping' };
  }
  const m = obj as Record<string, unknown>;
  if (!isKebab(m.id)) return { error: `manifest id missing or not kebab-case: ${String(m.id)}` };
  if (typeof m.title !== 'string' || !m.title.trim()) return { error: 'manifest title missing' };
  if (typeof m.description !== 'string' || !m.description.trim()) {
    return { error: 'manifest description missing' };
  }
  const version = typeof m.version === 'number' ? String(m.version) : m.version;
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    return { error: `manifest version must be three-part semver (got ${String(m.version)})` };
  }
  return {
    manifest: {
      id: m.id,
      title: m.title.trim(),
      description: m.description.trim(),
      version,
      ...(typeof m.author === 'string' && m.author.trim() ? { author: m.author.trim() } : {}),
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Learning files
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Parse one `<item-id>.md`. Tolerant on optionals (kind/applies_to default),
 * strict on essentials (title, non-empty body) — packs are curated artifacts;
 * a malformed item should fail validation, not seed silently degraded.
 */
export function parseLearningFile(
  raw: string,
  fallbackId: string,
): { item?: LearningItem; error?: string } {
  const fm = parseFrontmatter(raw);
  if (!fm) return { error: `${fallbackId}: missing frontmatter block` };

  const end = raw.indexOf('\n---', 4);
  // parseFrontmatter returned non-null, so the closing fence exists.
  const afterFence = raw.indexOf('\n', end + 1);
  const text = (afterFence >= 0 ? raw.slice(afterFence + 1) : '').trim();
  if (!text) return { error: `${fallbackId}: empty learning body` };

  const id = typeof fm.id === 'string' && fm.id ? fm.id : fallbackId;
  if (!isKebab(id)) return { error: `${fallbackId}: id not kebab-case: ${id}` };

  const title = typeof fm.title === 'string' ? fm.title.trim() : '';
  if (!title) return { error: `${id}: title missing` };

  let kind: LearningKind = 'feedback';
  if (fm.kind !== undefined) {
    if (typeof fm.kind !== 'string' || !(LEARNING_KINDS as readonly string[]).includes(fm.kind)) {
      return { error: `${id}: kind must be one of ${LEARNING_KINDS.join('|')} (got ${String(fm.kind)})` };
    }
    kind = fm.kind as LearningKind;
  }

  let appliesTo: AppliesTo[] = ['any'];
  if (fm.applies_to !== undefined) {
    const arr = Array.isArray(fm.applies_to) ? fm.applies_to : [fm.applies_to];
    const bad = arr.filter((s) => !(APPLIES_TO_SHAPES as readonly string[]).includes(s));
    if (bad.length > 0) {
      return { error: `${id}: applies_to has unknown shape(s): ${bad.join(', ')}` };
    }
    if (arr.length === 0) return { error: `${id}: applies_to must not be empty` };
    appliesTo = [...new Set(arr)] as AppliesTo[];
  }

  return { item: { id, title, kind, appliesTo, text } };
}

/* ────────────────────────────────────────────────────────────────────────
 * Pack-level validation + filtering
 * ──────────────────────────────────────────────────────────────────────── */

/** Whole-pack validation. Empty array = valid. */
export function validatePack(pack: LearningPack): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const item of pack.items) {
    if (seen.has(item.id)) errors.push(`duplicate learning id: ${item.id}`);
    seen.add(item.id);
  }
  if (pack.items.length === 0) errors.push('pack has no learnings');
  return errors;
}

/**
 * Which items seed for a project of the given shapes (D-002/D-008)?
 * - `shapes` undefined/empty (repo-less hive, no detection): `any`-tagged only.
 * - shapes known: `any` + items intersecting the shapes.
 */
export function filterByShapes(
  items: readonly LearningItem[],
  shapes?: readonly AppliesTo[],
): LearningItem[] {
  const known: readonly AppliesTo[] = (shapes ?? []).filter((s) => s !== 'any');
  return items.filter(
    (it) => it.appliesTo.includes('any') || it.appliesTo.some((a) => known.includes(a)),
  );
}

/**
 * The canonical memory-text render of a learning — one place, so seeded rows
 * are byte-identical across create/install/upgrade and the upgrade diff
 * (P-013) can detect "user edited this" by comparing against it.
 */
export function memoryTextOf(item: Pick<LearningItem, 'title' | 'text'>): string {
  return `${item.title} — ${item.text}`;
}

/** Provenance fields stamped into each seeded row's metadata (D-001). */
export interface PackProvenance {
  source: typeof PACK_MEMORY_SOURCE;
  pack_id: string;
  pack_version: string;
  pack_item_id: string;
}

export function provenanceOf(pack: LearningPack, item: LearningItem): PackProvenance {
  return {
    source: PACK_MEMORY_SOURCE,
    pack_id: pack.manifest.id,
    pack_version: pack.manifest.version,
    pack_item_id: item.id,
  };
}
