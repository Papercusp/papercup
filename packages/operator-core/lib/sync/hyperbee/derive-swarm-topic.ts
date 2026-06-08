/**
 * Derive a deterministic 32-byte Hyperswarm topic from a harness's
 * canonical identity.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 + the
 * hyperswarm-replication wiring (this loop).
 *
 * v5 §0.2.7 + addendum 1 — canonical binding is by GitHub repository
 * id (so a renamed repo / fork doesn't shard the swarm). Pre-binding,
 * fall back to a workspace+slug deterministic key so single-engineer
 * dev still discovers itself in the swarm.
 *
 * The topic is `sha256("papercusp-substrate-v1:" + binding)`, where
 * `binding` is one of:
 *   - `gh:<repository_id>`              — verified shared harness
 *   - `local:<workspace_id>/<slug>`    — pre-binding / private dev
 *   - `hive:<hive_pubkey>`             — a shared HIVE, keyed by its Ed25519
 *                                        pubkey (shared-hive-federation P-003)
 *
 * The `hive:` binding is the federation key that REPLACES the shared-harness
 * slug as the top-level unit (D-001/D-003): a Hive's Swarms all join this one
 * topic and the Hive's harnesses' work-sync federates WITHIN it (harness sync
 * becomes a component, not the top unit — P-004). It reuses this same
 * `papercusp-substrate-v1:` namespace because it is the SAME Model-B substrate,
 * only re-keyed (D-003: change the key, not the transport). The pubkey is the
 * raw-32-byte base64 hive id; anyone who learns it (via the directory / an
 * invite) can derive the topic and join — the hash domain-separates without
 * hiding anything from a pubkey holder.
 *
 * 32 bytes is exactly Hyperswarm's expected topic length. The v1
 * prefix lets us rotate the entire swarm scheme later by bumping it
 * (e.g. when the protocol changes incompatibly).
 *
 * Pure: no I/O, no random, fully deterministic. Tests assert that
 * the same binding yields the same topic across runs.
 */

import { createHash } from 'node:crypto';

const TOPIC_PREFIX = 'papercusp-substrate-v1:';

export type SwarmBinding =
  | { kind: 'gh'; github_repository_id: number | string }
  | { kind: 'local'; workspace_id: string; harness_slug: string }
  | { kind: 'hive'; hive_pubkey: string };

export function serializeBinding(b: SwarmBinding): string {
  if (b.kind === 'gh') {
    if (b.github_repository_id === '' || b.github_repository_id == null) {
      throw new Error('serializeBinding: gh binding requires non-empty github_repository_id');
    }
    return `gh:${String(b.github_repository_id)}`;
  }
  if (b.kind === 'hive') {
    if (!b.hive_pubkey) throw new Error('serializeBinding: hive binding requires hive_pubkey');
    return `hive:${b.hive_pubkey}`;
  }
  if (!b.workspace_id) throw new Error('serializeBinding: local binding requires workspace_id');
  if (!b.harness_slug) throw new Error('serializeBinding: local binding requires harness_slug');
  return `local:${b.workspace_id}/${b.harness_slug}`;
}

export function deriveSwarmTopic(binding: SwarmBinding): Buffer {
  const key = TOPIC_PREFIX + serializeBinding(binding);
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * The federation topic for a shared Hive, keyed by the Hive's Ed25519 pubkey
 * (shared-hive-federation-2026-06-08 P-003). Convenience wrapper over the
 * `hive:` binding — this is the per-Hive substrate topic that replaces the
 * shared-harness slug as the top-level federation key. `hivePubkeyBase64` is
 * the raw-32-byte base64 hive id from the Hive entity (hive-keypair.ts).
 */
export function deriveHiveFederationTopic(hivePubkeyBase64: string): Buffer {
  return deriveSwarmTopic({ kind: 'hive', hive_pubkey: hivePubkeyBase64 });
}

/** Diagnostic: hex-render the topic (good for logs + the substrate dashboard). */
export function topicAsHex(topic: Buffer): string {
  return topic.toString('hex');
}
