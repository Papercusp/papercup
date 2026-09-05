/**
 * Shared signed-context contract for the v2 pot-git envelopes (P-513/F2).
 *
 * The v1 envelopes intentionally remain readable for an explicit migration
 * window.  A v2 envelope binds the stable hive identity, federated repository
 * key, and store lineage to the device signature; receivers can therefore
 * reject a valid signature that belongs to another hive/repository/lineage.
 */
import { createHash } from 'node:crypto';

export const SIGNED_PROTOCOL_SCHEMA_VERSION = 2;

/** Stable identity covered by every v2 pot-git signature. */
export interface SignedProtocolContext {
  /** Federated hive identity (never a local install slug). */
  hive_id: string;
  /** Federated repository key (`canonicalRepoKey`). */
  repo_key: string;
  /** Stable identity for the current bare-store lineage. */
  store_generation: string;
}

function validPart(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isSignedProtocolContext(value: unknown): value is SignedProtocolContext {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return validPart(v.hive_id) && validPart(v.repo_key) && validPart(v.store_generation);
}

/** Compare only the signed identity tuple; callers decide whether v1 is allowed. */
export function signedProtocolContextMatches(
  value: Partial<SignedProtocolContext> | null | undefined,
  expected: SignedProtocolContext,
): boolean {
  return (
    value?.hive_id === expected.hive_id &&
    value?.repo_key === expected.repo_key &&
    value?.store_generation === expected.store_generation
  );
}

/**
 * Deterministic lineage id used by the runtime until a store has an explicit
 * persisted generation record.  It is derived from the federated identity,
 * never a local slug or device, so every member signs the same context.  A
 * future store-rotation record can replace this value without changing the
 * envelope or receiver contract.
 */
export function deriveStoreGeneration(hiveId: string, repoKey: string): string {
  return `sg1-${createHash('sha256')
    .update('papercusp-pot-git-store-generation-v1\n')
    .update(hiveId)
    .update('\n')
    .update(repoKey)
    .digest('hex')}`;
}

export function makeSignedProtocolContext(hiveId: string, repoKey: string): SignedProtocolContext {
  const context = { hive_id: hiveId, repo_key: repoKey, store_generation: deriveStoreGeneration(hiveId, repoKey) };
  if (!isSignedProtocolContext(context)) throw new Error('pot-git: invalid signed protocol context');
  return context;
}
