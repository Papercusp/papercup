/**
 * Coverage for cooldown-marks: readCooldownMark (row → Number, null when none)
 * and writeCooldownMark (upsert value-threading). org-PG drizzle `db` mocked
 * with a minimal chain (configurable select rows + captured insert values).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: { rows: unknown[]; lastValues: unknown } = { rows: [], lastValues: null };
  const db: Record<string, unknown> = {};
  Object.assign(db, {
    select: () => db,
    from: () => db,
    where: () => db,
    limit: async () => state.rows,
    insert: () => db,
    values: (v: unknown) => {
      state.lastValues = v;
      return db;
    },
    onConflictDoUpdate: async () => undefined,
  });
  return { db, state };
});
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ db: H.db }) };
});

import { readCooldownMark, writeCooldownMark } from './cooldown-marks';

beforeEach(() => {
  H.state.rows = [];
  H.state.lastValues = null;
});

describe('readCooldownMark', () => {
  it('returns the mark coerced to a number', async () => {
    H.state.rows = [{ marked_at_ms: '1700000000000' }];
    expect(await readCooldownMark('el-mint:agent-1')).toBe(1_700_000_000_000);
  });
  it('returns null when there is no row', async () => {
    H.state.rows = [];
    expect(await readCooldownMark('nope')).toBeNull();
  });
});

describe('writeCooldownMark', () => {
  it('upserts the key with the given timestamp', async () => {
    await writeCooldownMark('voice-test:ws', 5000);
    expect(H.state.lastValues).toMatchObject({ key: 'voice-test:ws', markedAtMs: 5000 });
    expect(typeof (H.state.lastValues as { updatedAt: number }).updatedAt).toBe('number');
  });
  it('defaults the timestamp to now when omitted', async () => {
    await writeCooldownMark('k');
    expect(typeof (H.state.lastValues as { markedAtMs: number }).markedAtMs).toBe('number');
  });
});
