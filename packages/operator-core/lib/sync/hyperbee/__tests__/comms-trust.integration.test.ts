/**
 * comms-trust integration (real PG) — mig 435 + the tier store + resolution
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-011). Pins:
 *   • CRUD: set/upsert (created_ts preserved), list, remove;
 *   • lattice helpers (commsTierAtLeast ordering);
 *   • resolution precedence: non-expired override → policy default → fallback;
 *   • an EXPIRED override is ignored (probationary grants decay to policy);
 *   • fail-soft: store/policy errors resolve to the fallback, never throw;
 *   • workspace isolation (D-004 — a grant never leaks across workspaces).
 *
 * Owns its schema (applies mig 435 + a minimal audit_log); no dev-DB contact.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import {
  listCommsTrust,
  setCommsTrust,
  removeCommsTrust,
  effectiveCommsTier,
  commsTierAtLeast,
  FALLBACK_COMMS_TIER,
} from '../../../trust/comms-trust';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG_435 = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql/435-comms-trust-list.sql');

function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

const WS = 'ws_ct';
const T0 = 1_700_000_000_000;
const noPolicy = { loadPolicyDefaultTier: async () => undefined };

describe('comms_trust_list (real PG, mig 435)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('comms_trust');
    await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
    await db.sql.unsafe(stripMeta(readFileSync(MIG_435, 'utf8')));
    // Minimal audit_log so the fire-safe audit insert lands (shape from user-trust-list).
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
        id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL, action text NOT NULL,
        subject text NOT NULL, details jsonb, workspace_id text NOT NULL)`);
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('lattice: observe < message < wake < steer', () => {
    expect(commsTierAtLeast('steer', 'wake')).toBe(true);
    expect(commsTierAtLeast('wake', 'wake')).toBe(true);
    expect(commsTierAtLeast('message', 'wake')).toBe(false);
    expect(commsTierAtLeast('observe', 'message')).toBe(false);
  });

  it('set → list → upsert (created_ts preserved) → remove, audited', async () => {
    await setCommsTrust(WS, { githubUserId: 42, tier: 'wake', note: 'peer dev', actor: 'su-t', nowMs: T0 }, db.sql);
    let list = await listCommsTrust(WS, db.sql);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ githubUserId: 42, tier: 'wake', note: 'peer dev', createdTs: T0 });

    await setCommsTrust(WS, { githubUserId: 42, tier: 'steer', actor: 'su-t', nowMs: T0 + 5000 }, db.sql);
    list = await listCommsTrust(WS, db.sql);
    expect(list[0]).toMatchObject({ tier: 'steer', createdTs: T0, updatedTs: T0 + 5000 });

    const audits = await db.sql`SELECT action FROM harness_shared.audit_log WHERE workspace_id = ${WS}`;
    expect(audits.length).toBeGreaterThanOrEqual(2);

    expect((await removeCommsTrust(WS, 42, 'su-t', db.sql)).removed).toBe(true);
    expect(await listCommsTrust(WS, db.sql)).toHaveLength(0);
  });

  it('resolution: override wins → policy default → fallback', async () => {
    await setCommsTrust(WS, { githubUserId: 7, tier: 'steer', actor: 'su-t', nowMs: T0 }, db.sql);
    expect(
      await effectiveCommsTier({ workspaceId: WS, hiveHomeSlug: 'h', githubUserId: 7, nowMs: T0 + 1 }, noPolicy, db.sql),
    ).toEqual({ tier: 'steer', source: 'override' });

    expect(
      await effectiveCommsTier(
        { workspaceId: WS, hiveHomeSlug: 'h', githubUserId: 999, nowMs: T0 },
        { loadPolicyDefaultTier: async () => 'wake' },
        db.sql,
      ),
    ).toEqual({ tier: 'wake', source: 'policy' });

    expect(
      await effectiveCommsTier({ workspaceId: WS, hiveHomeSlug: 'h', githubUserId: 999, nowMs: T0 }, noPolicy, db.sql),
    ).toEqual({ tier: FALLBACK_COMMS_TIER, source: 'fallback' });
  });

  it('an EXPIRED override decays to the policy default; an invalid policy tier is ignored', async () => {
    await setCommsTrust(
      WS,
      { githubUserId: 8, tier: 'steer', expiresAtMs: T0 + 1000, actor: 'su-t', nowMs: T0 },
      db.sql,
    );
    // fresh: override holds
    expect(
      (await effectiveCommsTier({ workspaceId: WS, hiveHomeSlug: 'h', githubUserId: 8, nowMs: T0 + 500 }, noPolicy, db.sql)).source,
    ).toBe('override');
    // expired: falls to policy
    expect(
      await effectiveCommsTier(
        { workspaceId: WS, hiveHomeSlug: 'h', githubUserId: 8, nowMs: T0 + 2000 },
        { loadPolicyDefaultTier: async () => 'message' },
        db.sql,
      ),
    ).toEqual({ tier: 'message', source: 'policy' });
    // garbage policy value → fallback, not a crash
    expect(
      await effectiveCommsTier(
        { workspaceId: WS, hiveHomeSlug: 'h', githubUserId: 8, nowMs: T0 + 2000 },
        { loadPolicyDefaultTier: async () => 'root-access-please' },
        db.sql,
      ),
    ).toEqual({ tier: FALLBACK_COMMS_TIER, source: 'fallback' });
  });

  it('fail-soft: a throwing policy leg resolves to fallback, never throws', async () => {
    expect(
      await effectiveCommsTier(
        { workspaceId: WS, hiveHomeSlug: 'h', githubUserId: 999, nowMs: T0 },
        {
          loadPolicyDefaultTier: async () => {
            throw new Error('policy store down');
          },
        },
        db.sql,
      ),
    ).toEqual({ tier: FALLBACK_COMMS_TIER, source: 'fallback' });
  });

  it('workspace isolation (D-004): a grant in WS never leaks to WS2', async () => {
    await setCommsTrust(WS, { githubUserId: 55, tier: 'steer', actor: 'su-t', nowMs: T0 }, db.sql);
    expect(
      await effectiveCommsTier({ workspaceId: 'ws_other', hiveHomeSlug: 'h', githubUserId: 55, nowMs: T0 + 1 }, noPolicy, db.sql),
    ).toEqual({ tier: FALLBACK_COMMS_TIER, source: 'fallback' });
    expect(await listCommsTrust('ws_other', db.sql)).toHaveLength(0);
  });
});
