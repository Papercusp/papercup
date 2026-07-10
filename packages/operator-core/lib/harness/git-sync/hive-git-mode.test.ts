/**
 * hive-git-mode — the per-hive GitHub-bridge mode seam
 * (github-bridge-hive-egress-2026-07-02 P-003). Unit-hermetic: db-org is mocked
 * (getOrgPg throws), reads run against an injected fake `sql` seam — which also
 * proves the fail-open contract (any store failure reads as 'legacy').
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => {
    throw new Error('getOrgPg must not be reached — inject sql in tests');
  },
}));

import {
  coercePotGitMode,
  getPotGitMode,
  setPotGitMode,
  POT_GIT_MODE_SETTING_KEY,
} from './hive-git-mode';

/** Fake postgres client: `unsafe` resolves the given rows (or rejects). */
const fakeSql = (rows: unknown[] | Error): Sql =>
  ({
    unsafe: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  }) as unknown as Sql;

const settingRow = (value: unknown) => ({
  workspace_id: 'ws',
  harness_slug: 'shop-hive',
  setting_key: POT_GIT_MODE_SETTING_KEY,
  value: JSON.stringify(value),
  created_at: 1,
  updated_at: 1,
});

describe('coercePotGitMode — junk-safe', () => {
  it('passes the two non-default modes through', () => {
    expect(coercePotGitMode('bridged')).toBe('bridged');
    expect(coercePotGitMode('p2p-only')).toBe('p2p-only');
  });

  it("everything else — junk strings, objects, null, undefined — reads as 'legacy'", () => {
    for (const junk of ['legacy', 'turbo', '', 'BRIDGED', 0, 1, true, null, undefined, {}, ['bridged']]) {
      expect(coercePotGitMode(junk)).toBe('legacy');
    }
  });
});

describe('getPotGitMode — federated read, fail-open to legacy', () => {
  it('reads a stored mode', async () => {
    expect(await getPotGitMode('ws', 'shop-hive', fakeSql([settingRow('bridged')]))).toBe('bridged');
    expect(await getPotGitMode('ws', 'shop-hive', fakeSql([settingRow('p2p-only')]))).toBe('p2p-only');
  });

  it("absent row → 'legacy'", async () => {
    expect(await getPotGitMode('ws', 'shop-hive', fakeSql([]))).toBe('legacy');
  });

  it("malformed stored value → 'legacy' (never a silent push-stop on junk)", async () => {
    expect(await getPotGitMode('ws', 'shop-hive', fakeSql([settingRow('turbo')]))).toBe('legacy');
  });

  it("store failure → 'legacy' (fail-open: a PG blip must not flip a legacy hive commit-only)", async () => {
    expect(await getPotGitMode('ws', 'shop-hive', fakeSql(new Error('pg down')))).toBe('legacy');
  });

  it("no injected sql + unreachable PG → 'legacy' (the default-resolver path in unit-shaped envs)", async () => {
    expect(await getPotGitMode('ws', 'shop-hive')).toBe('legacy');
  });
});

describe('setPotGitMode — writes validate, never coerce', () => {
  it('rejects a junk mode BEFORE touching the store', async () => {
    await expect(
      setPotGitMode('ws', 'shop-hive', 'turbo' as never, fakeSql([])),
    ).rejects.toThrow(/unknown mode 'turbo'/);
  });
});
