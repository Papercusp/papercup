/**
 * WI-40255: crash-safe cleanup for the multi-GB gym substrate roots.
 *
 * The selection predicate is deliberately tested independently from filesystem
 * size and process churn: a live owner must survive, while an aged dead owner
 * is reclaimable. The integration-shaped test also proves the sweep stays
 * inside the `gym-substrate-*` namespace and preserves the live root.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GYM_SUBSTRATE_OWNER_FILE,
  GYM_SUBSTRATE_PREFIX,
  createGymSubstrateRoot,
  shouldReapGymSubstrate,
  sweepOrphanedGymSubstrates,
  type GymSubstrateOwner,
} from './gym-substrate-orphan-sweep';

const deadOwner: GymSubstrateOwner = { pid: 999_999_999, processStartToken: 'dead', createdAtMs: 0 };

describe('gym substrate orphan selection', () => {
  it('retains an aged root whose owner PID is live', () => {
    const owner: GymSubstrateOwner = { pid: 123, processStartToken: 'start-a', createdAtMs: 0 };

    expect(shouldReapGymSubstrate(
      { ageMs: 24 * 60 * 60 * 1000, owner },
      { maxAgeMs: 60_000, isOwnerAlive: () => true },
    )).toBe(false);
  });

  it('selects an aged root whose owner PID is dead', () => {
    expect(shouldReapGymSubstrate(
      { ageMs: 24 * 60 * 60 * 1000, owner: deadOwner },
      { maxAgeMs: 60_000, isOwnerAlive: () => false },
    )).toBe(true);
  });

  it('retains an unowned root inside the sentinel-publish age floor', () => {
    expect(shouldReapGymSubstrate(
      { ageMs: 5_000, owner: null },
      { maxAgeMs: 60_000 },
    )).toBe(false);
  });
});

describe('sweepOrphanedGymSubstrates', () => {
  let parent: string | undefined;

  afterEach(() => {
    if (parent) rmSync(parent, { recursive: true, force: true });
    parent = undefined;
  });

  it('writes an owner sentinel and reclaims only the aged dead root', () => {
    parent = mkdtempSync(join(tmpdir(), 'gym-substrate-sweep-test-'));
    const live = createGymSubstrateRoot(parent);
    const sentinel = JSON.parse(readFileSync(join(live.root, GYM_SUBSTRATE_OWNER_FILE), 'utf8')) as GymSubstrateOwner;
    expect(sentinel.pid).toBe(process.pid);
    expect(sentinel.createdAtMs).toBeGreaterThan(0);

    const dead = mkdtempSync(join(parent, GYM_SUBSTRATE_PREFIX));
    writeFileSync(join(dead, GYM_SUBSTRATE_OWNER_FILE), `${JSON.stringify(deadOwner)}\n`);
    const unrelated = join(parent, 'not-a-gym-substrate');
    mkdirSync(unrelated);

    const result = sweepOrphanedGymSubstrates({
      parentDir: parent,
      maxAgeMs: 0,
      isOwnerAlive: (owner) => owner.pid === process.pid,
    });

    expect(result.swept).toEqual([dead.split('/').at(-1)]);
    expect(result.retained).toEqual([live.root.split('/').at(-1)]);
    expect(result.errors).toEqual([]);
  });
});
