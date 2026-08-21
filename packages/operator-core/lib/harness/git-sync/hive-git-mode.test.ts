/**
 * hive-git-mode — the per-hive GitHub-bridge mode seam
 * (github-bridge-hive-egress-2026-07-02 P-003). Unit-hermetic: db-org is mocked
 * (getOrgPg throws), reads run against an injected fake `sql` seam — which also
 * proves the fail-open contract (any store failure reads as 'legacy').
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => {
    throw new Error('getOrgPg must not be reached — inject sql in tests');
  },
}));

import {
  coercePotGitMode,
  getPotGitMode,
  readPotGitMode,
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

/**
 * WI-6815 — the four states `getPotGitMode` collapses into one `legacy`. The
 * SERVE gate refuses on `legacy`, so for it the collapse turns "I could not read
 * the mode" into "this hive chose not to serve" — indistinguishable from the
 * dialing side, which is what made WI-6815 undiagnosable without peer DB access.
 */
describe('readPotGitMode — separates an owner-chosen legacy from a failed read', () => {
  it("an explicitly-stored 'legacy' is source 'set' — the ONLY case that is an owner decision", async () => {
    expect(await readPotGitMode('ws', 'shop-hive', fakeSql([settingRow('legacy')]))).toEqual({
      mode: 'legacy',
      source: 'set',
    });
  });

  it("a stored non-default mode is source 'set'", async () => {
    expect(await readPotGitMode('ws', 'shop-hive', fakeSql([settingRow('bridged')]))).toEqual({
      mode: 'bridged',
      source: 'set',
    });
    expect(await readPotGitMode('ws', 'shop-hive', fakeSql([settingRow('p2p-only')]))).toEqual({
      mode: 'p2p-only',
      source: 'set',
    });
  });

  it("no row → source 'absent', NOT 'set' — the hive never chose legacy, the setting is simply not here", async () => {
    expect(await readPotGitMode('ws', 'shop-hive', fakeSql([]))).toEqual({
      mode: 'legacy',
      source: 'absent',
    });
  });

  it("a NULL-valued row is 'absent' too (a tombstoned setting is not a choice)", async () => {
    expect(await readPotGitMode('ws', 'shop-hive', fakeSql([settingRow(null)]))).toEqual({
      mode: 'legacy',
      source: 'absent',
    });
  });

  it("junk value → source 'malformed' — coercion still yields legacy, but the row is corrupt, not a decision", async () => {
    expect(await readPotGitMode('ws', 'shop-hive', fakeSql([settingRow('turbo')]))).toEqual({
      mode: 'legacy',
      source: 'malformed',
    });
    // Case matters: 'BRIDGED' coerces to legacy and is a misconfiguration, not an
    // owner opting out of P2P.
    expect(await readPotGitMode('ws', 'shop-hive', fakeSql([settingRow('BRIDGED')]))).toEqual({
      mode: 'legacy',
      source: 'malformed',
    });
  });

  it("a THROWN store read → source 'error' — the mode is UNKNOWN; it must never present as an owner's legacy", async () => {
    expect(await readPotGitMode('ws', 'shop-hive', fakeSql(new Error('pg down')))).toEqual({
      mode: 'legacy',
      source: 'error',
    });
  });

  it('never throws, even with no injected sql and an unreachable PG', async () => {
    await expect(readPotGitMode('ws', 'shop-hive')).resolves.toEqual({
      mode: 'legacy',
      source: 'error',
    });
  });

  it("getPotGitMode stays byte-identical across all four states — the PUSH path's contract is unchanged", async () => {
    const cases: Array<[unknown[] | Error, string]> = [
      [[settingRow('legacy')], 'legacy'],
      [[settingRow('bridged')], 'bridged'],
      [[], 'legacy'],
      [[settingRow('turbo')], 'legacy'],
      [new Error('pg down'), 'legacy'],
    ];
    for (const [rows, expected] of cases) {
      const sql = fakeSql(rows);
      expect(await getPotGitMode('ws', 'shop-hive', sql)).toBe(expected);
      // ...and it agrees with the richer read's `mode`, so the two can never drift.
      expect((await readPotGitMode('ws', 'shop-hive', sql)).mode).toBe(expected);
    }
  });
});

describe('setPotGitMode — writes validate, never coerce', () => {
  it('rejects a junk mode BEFORE touching the store', async () => {
    await expect(
      setPotGitMode('ws', 'shop-hive', 'turbo' as never, fakeSql([])),
    ).rejects.toThrow(/unknown mode 'turbo'/);
  });
});
