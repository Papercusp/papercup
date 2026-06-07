/**
 * The shipped brand packs.
 *
 * `classic` reproduces today's user-facing terminology (flag off = no visual
 * change). `the-hive` is the approved Swarm/Hive lexicon (plan
 * the-hive-lexicon-2026-06-06 D-002). Term *keys* are brand-neutral; only the
 * labels here change. Internal identifiers (code, DB columns, MCP tool names,
 * repos) are NEVER driven by this map — it is presentation only (D-001).
 *
 * NOTE: `classic` labels are the baseline that must match the live UI at each
 * callsite that gets routed through the resolver. When a routed callsite shows
 * a different word today, fix the label here — never the callsite — so flag-off
 * stays identical.
 */
import type { BrandPack, BrandPackId, TermKey } from './types';

const CLASSIC_TERMS: Record<TermKey, { one: string; other: string }> = {
  pot: { one: 'Pot', other: 'Pots' },
  fleet: { one: 'Fleet', other: 'Fleets' },
  operator: { one: 'Operator', other: 'Operators' },
  brain: { one: 'Brain', other: 'Brains' },
  contributor: { one: 'Contributor', other: 'Contributors' },
  human: { one: 'Human', other: 'Humans' },
  chunk: { one: 'Chunk', other: 'Chunks' },
  cupboard: { one: 'Cupboard', other: 'Cupboards' },
  node: { one: 'Node', other: 'Nodes' },
  substrate: { one: 'Coordination', other: 'Coordination' },
  blueprint: { one: 'Blueprint', other: 'Blueprints' },
  harness: { one: 'Harness', other: 'Harnesses' },
  signal: { one: 'Signal', other: 'Signals' },
};

const THE_HIVE_TERMS: Record<TermKey, { one: string; other: string }> = {
  pot: { one: 'Hive', other: 'Hives' },
  fleet: { one: 'Swarm', other: 'Swarms' },
  // Canon (the-hive-lexicon D-002 table): the coordination orchestrator IS the
  // Queen — resolves the two-meanings-of-"operator" collision. `brain` has no
  // canon row; Royal Jelly = what makes a Queen (the intelligence/memory layer).
  operator: { one: 'Queen', other: 'Queens' },
  brain: { one: 'Royal Jelly', other: 'Royal Jelly' },
  contributor: { one: 'Bee', other: 'Bees' },
  human: { one: 'Keeper', other: 'Keepers' },
  chunk: { one: 'Cell', other: 'Cells' },
  cupboard: { one: 'Comb', other: 'Combs' },
  node: { one: 'Frame', other: 'Frames' },
  substrate: { one: 'Hive Mind', other: 'Hive Minds' },
  // Kept names (D-002): blueprint + harness stay as-is across packs.
  blueprint: { one: 'Blueprint', other: 'Blueprints' },
  harness: { one: 'Harness', other: 'Harnesses' },
  // Optional flavor — the waggle dance.
  signal: { one: 'Waggle', other: 'Waggles' },
};

export const CLASSIC_PACK: BrandPack = {
  id: 'classic',
  label: 'Classic (Papercusp)',
  terms: CLASSIC_TERMS,
};

export const THE_HIVE_PACK: BrandPack = {
  id: 'the-hive',
  label: 'The Swarm',
  terms: THE_HIVE_TERMS,
};

/** Registry of every shipped pack, keyed by id. */
export const BRAND_PACKS: Record<BrandPackId, BrandPack> = {
  classic: CLASSIC_PACK,
  'the-hive': THE_HIVE_PACK,
};

/** The default pack — the no-rebrand baseline (flag off). */
export const DEFAULT_PACK_ID: BrandPackId = 'classic';

/** Every shipped pack id. */
export const BRAND_PACK_IDS: readonly BrandPackId[] = Object.keys(
  BRAND_PACKS,
) as BrandPackId[];
