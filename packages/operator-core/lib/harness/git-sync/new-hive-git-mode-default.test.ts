/**
 * new-hive-git-mode-default.test.ts — P-503 (WI-10004765): the configurable
 * default `hiveGit.mode` for NEW shared coding hives. Every seam faked — no PG.
 */
import { describe, it, expect } from 'vitest';
import {
  applyNewHiveGitModeDefault,
  resolveNewHiveGitModeDefault,
  type ApplyNewHiveGitModeDeps,
} from './new-hive-git-mode-default';
import type { PotGitMode, PotGitModeRead } from './hive-git-mode';

function fakes(policy: Record<string, unknown>, current: PotGitModeRead = { mode: 'legacy', source: 'absent' }) {
  const writes: { ws: string; slug: string; mode: PotGitMode }[] = [];
  const reads: string[] = [];
  const deps: ApplyNewHiveGitModeDeps = {
    readPolicy: async () => policy as never,
    readMode: async (_ws, slug) => {
      reads.push(slug);
      return current;
    },
    setMode: async (ws, slug, mode) => {
      writes.push({ ws, slug, mode });
    },
  };
  return { deps, writes, reads };
}

describe('resolveNewHiveGitModeDefault', () => {
  it('unset policy ⇒ legacy (the shipped posture)', () => {
    expect(resolveNewHiveGitModeDefault({})).toBe('legacy');
    expect(resolveNewHiveGitModeDefault(null)).toBe('legacy');
    expect(resolveNewHiveGitModeDefault(undefined)).toBe('legacy');
  });
  it('passes every valid mode through', () => {
    for (const m of ['legacy', 'bridged', 'p2p-only'] as const) {
      expect(resolveNewHiveGitModeDefault({ newHiveGitMode: m })).toBe(m);
    }
  });
  it('an unrecognised value is invalid (null), never coerced', () => {
    expect(resolveNewHiveGitModeDefault({ newHiveGitMode: 'BRIDGED' as never })).toBeNull();
    expect(resolveNewHiveGitModeDefault({ newHiveGitMode: 1 as never })).toBeNull();
  });
});

describe('applyNewHiveGitModeDefault', () => {
  it('default (unset) writes NOTHING and never reads the hive', async () => {
    const { deps, writes, reads } = fakes({});
    expect(await applyNewHiveGitModeDefault('ws', 'shop-pot', deps)).toEqual({
      applied: false,
      reason: 'default-legacy',
      mode: 'legacy',
    });
    expect(writes).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('explicit legacy default also writes nothing', async () => {
    const { deps, writes } = fakes({ newHiveGitMode: 'legacy' });
    expect(await applyNewHiveGitModeDefault('ws', 'shop-pot', deps)).toMatchObject({ reason: 'default-legacy' });
    expect(writes).toEqual([]);
  });

  it('bridged default is applied to a hive with no mode row', async () => {
    const { deps, writes } = fakes({ newHiveGitMode: 'bridged' });
    expect(await applyNewHiveGitModeDefault('ws', 'shop-pot', deps)).toEqual({ applied: true, mode: 'bridged' });
    expect(writes).toEqual([{ ws: 'ws', slug: 'shop-pot', mode: 'bridged' }]);
  });

  it('never overwrites a mode already set on the hive', async () => {
    const { deps, writes } = fakes({ newHiveGitMode: 'bridged' }, { mode: 'p2p-only', source: 'set' });
    expect(await applyNewHiveGitModeDefault('ws', 'shop-pot', deps)).toEqual({
      applied: false,
      reason: 'already-set',
      mode: 'p2p-only',
      source: 'set',
    });
    expect(writes).toEqual([]);
  });

  it('a malformed existing row is left alone (operator concern), not papered over', async () => {
    const { deps, writes } = fakes({ newHiveGitMode: 'bridged' }, { mode: 'legacy', source: 'malformed' });
    expect(await applyNewHiveGitModeDefault('ws', 'shop-pot', deps)).toMatchObject({
      reason: 'already-set',
      source: 'malformed',
    });
    expect(writes).toEqual([]);
  });

  it('an invalid configured default is reported and ignored', async () => {
    const { deps, writes } = fakes({ newHiveGitMode: 'yolo' });
    expect(await applyNewHiveGitModeDefault('ws', 'shop-pot', deps)).toEqual({
      applied: false,
      reason: 'invalid-default',
      configured: 'yolo',
    });
    expect(writes).toEqual([]);
  });

  it('never throws — a failing write folds into reason:error', async () => {
    const { deps } = fakes({ newHiveGitMode: 'bridged' });
    deps.setMode = async () => {
      throw new Error('hive_settings down');
    };
    expect(await applyNewHiveGitModeDefault('ws', 'shop-pot', deps)).toEqual({
      applied: false,
      reason: 'error',
      message: 'hive_settings down',
    });
  });
});
