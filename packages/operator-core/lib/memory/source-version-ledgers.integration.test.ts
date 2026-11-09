/** Real PostgreSQL coverage for source-version dedup and exact native receipts.
 * This exercises the draft migration in an isolated org fixture before arming it.
 * Corpus adapter lifecycle reads and native process emission are separate gates. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { SqlTag } from './bump-last-surfaced';
import { contextSourceVersion } from './temporal-render';

const host = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: host.sql }),
}));
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { alreadySurfacedIds, stampSurfacedResult, memoryFragmentOffer, stageMemoryEmission,
  confirmMemoryEmission, _resetSessionEpochLedgerForTests } = await import('./session-epoch-ledger');
const { alreadySurfacedRefs, stampSurfacedRefsResult, _resetCorpusLedgerLatchForTests } = await import('./corpus-surfaced-ledger');
const { resetReadCursorStore } = await import('../agent-tools/coordination/read-cursors');

describe('canonical source version PostgreSQL ledgers', () => {
  let db: OrgTestDb;
  const armed = new URL('../../../../libs/papercusp/libs/db/sql/1627-context-source-version-ledgers.sql', import.meta.url);
  const draft = new URL(armed.href + '.DRAFT');
  beforeAll(async () => {
    db = await createOrgTestDb();
    host.sql = db.adminSql;
    const migration = readFileSync(existsSync(armed) ? armed : draft, 'utf8');
    await db.adminSql.unsafe(migration);
    await db.adminSql.unsafe(migration); // additive migration remains idempotent
    _resetSessionEpochLedgerForTests();
    _resetCorpusLedgerLatchForTests();
    resetReadCursorStore();
  }, 120_000);
  afterAll(async () => { resetReadCursorStore(); await db?.cleanup(); });

  it.each(['memory', 'corpus'] as const)('allows same-epoch %s corrections and requires the exact version on confirmation', async kind => {
    const sql = db.adminSql as unknown as SqlTag;
    const owner = `version-ledger:${randomUUID()}`, id = kind === 'memory' ? randomUUID() : `doc:${randomUUID()}`;
    const read = (fingerprint: string, epoch = 3) => kind === 'memory'
      ? alreadySurfacedIds(sql, owner, epoch, [id], new Map([[id, fingerprint]]))
      : alreadySurfacedRefs(sql, owner, epoch, [id], new Map([[id, fingerprint]]));
    const stamp = kind === 'memory' ? stampSurfacedResult : stampSurfacedRefsResult;
    const version = (fullText: string, revision: string) => contextSourceVersion({ namespace: kind, ref: id,
      fullText, revision, updatedAt: null, passage: { startByte: 0, endByte: 12 },
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const firstVersion = version('same passage\nOnly after approval.', 'r1');
    const nextVersion = version('same passage\nOnly after independent approval.', 'r2');
    const first = memoryFragmentOffer(kind, id, 3, 'turn-start', 'same passage', firstVersion);
    const next = memoryFragmentOffer(kind, id, 3, 'claim', 'same passage', nextVersion);
    const native = ({ rendered: _body, sourceVersion: _host, ...manifest }: typeof first) => manifest;
    expect(first.bodySha256).toBe(next.bodySha256);
    expect(await stamp(sql, owner, 3, [id], 'legacy')).toEqual({ ok: true, inserted: 1 });
    expect(await read(firstVersion.fingerprint)).toEqual(new Set());
    await stageMemoryEmission(sql, owner, 'first-version', [first]);
    await stageMemoryEmission(sql, owner, 'late-first-version', [first]);
    expect(await read(firstVersion.fingerprint)).toEqual(new Set()); // preparation is not delivery
    const proof = { token: 'first-version', fragments: [native(first)] };
    expect(await confirmMemoryEmission(sql, owner, { ...proof,
      fragments: [{ ...native(first), sourceFingerprint: nextVersion.fingerprint }] })).toBe(0);
    expect(await confirmMemoryEmission(sql, owner, proof)).toBe(1);
    expect(await read(firstVersion.fingerprint)).toEqual(new Set([id]));
    expect(await read(nextVersion.fingerprint)).toEqual(new Set());
    await stageMemoryEmission(sql, owner, 'next-version', [next]);
    expect(await confirmMemoryEmission(sql, owner, { token: 'next-version', fragments: [native(next)] })).toBe(1);
    expect(await read(nextVersion.fingerprint)).toEqual(new Set([id]));
    // A legacy port cannot erase an already-versioned stamp.
    expect(await stamp(sql, owner, 3, [id], 'legacy')).toEqual({ ok: true, inserted: 0 });
    expect(await read(nextVersion.fingerprint)).toEqual(new Set([id]));
    // A delayed old receipt cannot certify the newer source. Replay is safe.
    expect(await confirmMemoryEmission(sql, owner, { token: 'late-first-version', fragments: [native(first)] })).toBe(1);
    expect(await read(nextVersion.fingerprint)).toEqual(new Set());
    await stageMemoryEmission(sql, owner, 'retry-next-version', [next]);
    expect(await confirmMemoryEmission(sql, owner, { token: 'retry-next-version', fragments: [native(next)] })).toBe(1);
    await stageMemoryEmission(sql, owner, 'same-version', [next]);
    expect(await confirmMemoryEmission(sql, owner, { token: 'same-version', fragments: [native(next)] })).toBe(0);
    expect(await read(nextVersion.fingerprint)).toEqual(new Set([id]));
    expect(await read(nextVersion.fingerprint, 4)).toEqual(new Set());
  });
});
