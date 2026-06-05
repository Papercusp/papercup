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
  | { kind: 'local'; workspace_id: string; harness_slug: string };

export function serializeBinding(b: SwarmBinding): string {
  if (b.kind === 'gh') {
    if (b.github_repository_id === '' || b.github_repository_id == null) {
      throw new Error('serializeBinding: gh binding requires non-empty github_repository_id');
    }
    return `gh:${String(b.github_repository_id)}`;
  }
  if (!b.workspace_id) throw new Error('serializeBinding: local binding requires workspace_id');
  if (!b.harness_slug) throw new Error('serializeBinding: local binding requires harness_slug');
  return `local:${b.workspace_id}/${b.harness_slug}`;
}

export function deriveSwarmTopic(binding: SwarmBinding): Buffer {
  const key = TOPIC_PREFIX + serializeBinding(binding);
  return createHash('sha256').update(key, 'utf8').digest();
}

/** Diagnostic: hex-render the topic (good for logs + the substrate dashboard). */
export function topicAsHex(topic: Buffer): string {
  return topic.toString('hex');
}
