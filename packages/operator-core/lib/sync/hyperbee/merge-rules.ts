import type { OpEnvelope } from './op-envelope-types';

/** Every merge rule a table may declare. */
export const MERGE_RULES = ['lww', 'append-only', 'set-union', 'counter'] as const;
export type MergeRule = (typeof MERGE_RULES)[number];

/**
 * P-003 (p2p-v1-core-release-2026-11-13): the v1 simple rule set — the declared
 * rule kinds whose fold is proven to converge under duplicated, reordered and
 * delayed delivery. `lww` folds to one HLC winner per key; every other rule gives
 * each contribution its own event address ({@link operationGroupKey}), so a
 * replayed contribution dedupes instead of re-applying. That holds for `counter`
 * too: __tests__/p532-prospective-merge-contract.test.ts proves counter
 * contributions survive both fold paths without replay inflation. Any other
 * declared value (an unknown or misspelled rule) is outside the set and never
 * replicates. Kept separate from {@link MERGE_RULES} so the replication policy
 * can narrow without changing what a table may declare.
 */
export const V1_SIMPLE_MERGE_RULES = MERGE_RULES;
export type SimpleMergeRule = (typeof V1_SIMPLE_MERGE_RULES)[number];

export function isSimpleMergeRule(rule: unknown): rule is SimpleMergeRule {
  return (V1_SIMPLE_MERGE_RULES as readonly unknown[]).includes(rule);
}

/** Explicit production census. A new replicated table must choose its semantics from the v1 simple set. */
export const TABLE_MERGE_RULES: Readonly<Record<string, SimpleMergeRule>> = {
  contributors: 'lww',
  claims: 'append-only',
  queue: 'lww',
  'working-set': 'lww',
  'features-by-id': 'lww',
  'plans-by-slug': 'lww',
  issues: 'lww',
  presence: 'lww',
  // Usage is an immutable event ledger; additive totals are derived from its rows.
  usage: 'append-only',
  'coord-conversations': 'lww',
  'coord-messages': 'lww',
  'coord-threads': 'lww',
  'coord-thread-posts': 'lww',
  'item-assignments': 'lww',
  'hive-settings-by-key': 'lww',
  'agent-facts-by-key': 'lww',
  'p2p-memories-by-id': 'lww',
  'gym-qd-elites-by-niche': 'lww',
  'bee-claim-specs': 'lww',
  'gate-verdicts': 'append-only',
  'hive-policy': 'lww',
  'hive-reports': 'lww',
  'hive-pending-joins': 'lww',
  'hive-members': 'set-union',
  'hive-epoch-keys': 'lww',
  'engineer-issues': 'lww',
  'plan-parts': 'lww',
  'p2p-peer-grants': 'lww',
  'p2p-receipts': 'append-only',
  'p2p-fleet-directory': 'lww',
  'p2p-work-offers': 'lww',
  'p2p-fleet-leader-leases': 'lww',
};

export function mergeRuleFor(table: string, declared?: unknown): MergeRule | undefined {
  const rule = declared ?? TABLE_MERGE_RULES[table];
  if (rule === undefined) return undefined;
  if (rule === 'lww' || rule === 'append-only' || rule === 'set-union' || rule === 'counter') return rule;
  throw new Error(`Invalid merge rule for replicated table ${table}`);
}

/**
 * P-003: the rule a table replicates under, or `undefined` when it must not
 * replicate at all — no declared rule, or a declared rule outside the v1 simple
 * set. Every replication seam (capture, fold, apply) asks this one question, so
 * a missing or non-simple rule fails closed instead of defaulting to LWW.
 */
export function replicationRuleFor(table: string, declared?: unknown): SimpleMergeRule | undefined {
  // Deliberately not mergeRuleFor: an invalid declared value fails closed here
  // (no replication) instead of throwing mid-fold.
  const rule: unknown = declared ?? TABLE_MERGE_RULES[table];
  return isSimpleMergeRule(rule) ? rule : undefined;
}

/** The registration form of {@link replicationRuleFor}: refuse the declaration with its reason. */
export function assertReplicationRule(table: string, declared?: unknown): SimpleMergeRule {
  const rule: unknown = declared ?? TABLE_MERGE_RULES[table];
  if (rule === undefined) throw new Error(`Missing merge rule for replicated table ${table}`);
  if (!isSimpleMergeRule(rule)) {
    throw new Error(
      `Merge rule '${String(rule)}' for replicated table ${table} is outside the v1 simple rule set ` +
        `(${V1_SIMPLE_MERGE_RULES.join(', ')}); v1 does not replicate it`,
    );
  }
  return rule;
}

/**
 * Fold addresses never rewrite the wire key or author used by encrypted AAD.
 * An op whose table has no replication rule keeps its own event address, so it
 * never takes part in a winner choice under an assumed rule (P-003 fail-closed);
 * the apply path then refuses it.
 */
export function operationGroupKey(op: OpEnvelope, rule = replicationRuleFor(op.table ?? '')): string {
  const key = `${op.table}::${op.hbKey}`;
  if (rule === 'lww') return key;
  // Each contribution reaches its idempotent table writer. In particular, an old
  // contribution from another source must not lose to the latest same-key clock.
  return `${key}::event:${JSON.stringify([
    op.sourceLogKeyHex ?? '', op.writerPubkey ?? '', op.hlc ?? null, op.ts ?? null, op.type,
  ])}`;
}
