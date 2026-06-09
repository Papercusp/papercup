/**
 * The genome surface — the ONE canonical config-variation surface of a papercusp
 * instance, defined here once and pointed at by everything that varies an instance
 * (`self-improvement-stack-reconciliation-2026-06-09` D-002; `retire-snapshots-
 * instance-spec-2026-06-09` D-004).
 *
 * It IS, all the same thing:
 *   - `InstanceSpec.genome` (the reproducible-clone descriptor's variable field),
 *   - the eval-battery `InstanceSubject` variant surface (a genome delta),
 *   - the Apiary's "genome surface" decision (apiary P-011),
 *   - Scout's whole-system idea surface (hive-creative-ideation).
 *
 * The surface (the "interacting wholes"): **Queen prompt × placement policy ×
 * memory architecture × wake policy × coordination economy**. A genome is ONE
 * content-addressed, diffable artifact: a map of **prompt overlays** (the Queen-
 * prompt axis) + a small **config** object (the placement/wake/memory/coordination
 * knobs). Never-auto / safety surfaces are structurally EXCLUDED — they are not
 * fields here, so a genome can never vary them.
 *
 * v1 membership (apiary P-011's recommended knob set — highest system-level
 * leverage, zero blast radius, untestable in the gym): the Queen placement prompt,
 * wake / min-sleep floors, and the memory-seeding policy. The type carries all five
 * axes so the surface can grow to its full membership once the hive-creative/apiary
 * reconciliation ratifies it (that plan's P-001, `needs-human`) without a breaking
 * change — until then the extra axes are simply unused by capture.
 */
import { createHash } from 'node:crypto';

/** Schema version of the genome artifact (bump on a breaking shape change). */
export const GENOME_SCHEMA_VERSION = 1;

/**
 * Prompt overlays — the Queen-prompt axis. A map of a harness-relative path
 * (e.g. `genome/queen.placement.md`) → the overlay prompt text. Stored under the
 * harness's `.papercusp/genome/` so it is git-canonical + diffable.
 */
export type GenomePrompts = Record<string, string>;

/**
 * The declared, mutable CONFIG knobs of the genome surface. Each axis is an open
 * record so a knob set can grow without a type change; the genome NEVER carries a
 * safety / never-auto surface (those aren't fields here by construction).
 */
export interface GenomeConfig {
  /** Placement policy — where the Queen + bees run (e.g. `{ queen: 'dedicated' }`). */
  placement?: Record<string, unknown>;
  /** Wake policy — wake cadence + min-sleep floors (e.g. `{ minSleepSec: 60 }`). */
  wake?: Record<string, unknown>;
  /** Memory architecture / seeding policy (e.g. `{ seed: 'champion' }`). */
  memory?: Record<string, unknown>;
  /** Coordination economy (e.g. `{ broadcastBudget: 'low' }`). */
  coordination?: Record<string, unknown>;
}

/** The five config axes, in canonical order. */
export const GENOME_CONFIG_AXES = ['placement', 'wake', 'memory', 'coordination'] as const;
export type GenomeConfigAxis = (typeof GENOME_CONFIG_AXES)[number];

/**
 * A genome — the config-variation surface of one instance. Two parts: prompt
 * overlays (the Queen prompt axis) and config knobs (placement/wake/memory/
 * coordination). Content-addressed via {@link hashGenome}.
 */
export interface Genome {
  prompts: GenomePrompts;
  config: GenomeConfig;
}

/** A partial overlay applied to a genome to produce a same-origin clone. */
export interface GenomeDelta {
  /** Prompt overlays to add/replace. A value of `null` REMOVES that overlay. */
  prompts?: Record<string, string | null>;
  /** Config-axis overlays — shallow-merged per axis onto the base. */
  config?: Partial<GenomeConfig>;
}

/** The empty genome — a vanilla instance with no config variation. */
export const EMPTY_GENOME: Genome = Object.freeze({ prompts: {}, config: {} }) as Genome;

/** True when a genome carries no prompt overlays and no config knobs. */
export function genomeIsEmpty(g: Genome): boolean {
  if (Object.keys(g.prompts).length > 0) return false;
  for (const axis of GENOME_CONFIG_AXES) {
    const v = g.config[axis];
    if (v && Object.keys(v).length > 0) return false;
  }
  return true;
}

/** Normalize a genome to its canonical shape (sorted prompts, only the known config
 *  axes, dropped empties) so equal genomes hash identically. Pure. */
export function normalizeGenome(g: Genome): Genome {
  const prompts: GenomePrompts = {};
  for (const key of Object.keys(g.prompts).sort()) prompts[key] = g.prompts[key]!;
  const config: GenomeConfig = {};
  for (const axis of GENOME_CONFIG_AXES) {
    const v = g.config[axis];
    if (v && Object.keys(v).length > 0) config[axis] = v;
  }
  return { prompts, config };
}

/**
 * Apply a genome delta → a new genome (the `vary` primitive's genome half). Pure.
 * Prompt overlays merge (a `null` value removes); config axes shallow-merge.
 */
export function mergeGenome(base: Genome, delta: GenomeDelta): Genome {
  const prompts: GenomePrompts = { ...base.prompts };
  for (const [k, v] of Object.entries(delta.prompts ?? {})) {
    if (v === null) delete prompts[k];
    else prompts[k] = v;
  }
  const config: GenomeConfig = { ...base.config };
  for (const axis of GENOME_CONFIG_AXES) {
    const patch = delta.config?.[axis];
    if (patch) config[axis] = { ...(config[axis] ?? {}), ...patch };
  }
  return normalizeGenome({ prompts, config });
}

/** Deterministic, key-sorted JSON of any value — equal values stringify identically. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** Canonical JSON of a genome (normalized first) — the content-address pre-image. */
export function canonicalGenomeJson(g: Genome): string {
  return canonicalJson(normalizeGenome(g));
}

/**
 * Content-address a genome → a stable `gnm_<hex16>` id. Equal genomes (modulo key
 * order) hash to the same id; this is the `genomeId` the eval-battery records and
 * the same-origin-clone fairness key (same code SHA + different `genomeId`).
 */
export function hashGenome(g: Genome): string {
  const hex = createHash('sha256').update(canonicalGenomeJson(g)).digest('hex').slice(0, 16);
  return `gnm_${hex}`;
}

/**
 * The v1 genome surface membership, for docs/introspection. The full surface is
 * the five axes; v1 capture/vary actively use the recommended knob subset
 * (apiary P-011). Growing this is a config change, not a breaking type change.
 */
export const GENOME_SURFACE_V1 = Object.freeze({
  version: GENOME_SCHEMA_VERSION,
  promptAxis: 'queen-prompt',
  configAxes: GENOME_CONFIG_AXES,
  /** The recommended v1 active knobs (apiary P-011). */
  v1Knobs: ['queen-placement-prompt', 'wake/min-sleep-floors', 'memory-seeding-policy'],
  /** Structurally excluded — never a genome field, so a genome can't vary them. */
  excluded: ['safety/never-auto surfaces', 'credentials', 'secrets'],
} as const);
