/** Real PostgreSQL coverage for source-version dedup and exact native receipts.
 * This exercises the draft migration in an isolated org fixture before arming it.
 * Corpus adapter lifecycle reads and native process emission are separate gates. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { SqlTag } from './bump-last-surfaced';
import { contextSourceVersion } from './temporal-render';
import { CanonicalVectorStore, Mem0Backend, EMBEDDER_DIM_SPECS, MEMORY_VECTOR_STORAGE_PROFILES } from '@papercusp/memory';

const host = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: host.sql }),
}));
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { alreadySurfacedIds, stampSurfacedResult, memoryFragmentOffer, stageMemoryEmission,
  confirmMemoryEmission, memorySourcesDueForRevalidation, _resetSessionEpochLedgerForTests } = await import('./session-epoch-ledger');
const { alreadySurfacedRefs, stampSurfacedRefsResult, corpusSourcesDueForRevalidation,
  _resetCorpusLedgerLatchForTests } = await import('./corpus-surfaced-ledger');
const { resetReadCursorStore } = await import('../agent-tools/coordination/read-cursors');

describe('canonical source version PostgreSQL ledgers', () => {
  let db: OrgTestDb;
  let store: CanonicalVectorStore;
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
    store = new CanonicalVectorStore({ host: 'fixture', port: 5432, user: 'fixture', password: 'fixture', dbname: 'fixture',
      schema: 'harness_shared', collectionName: 'operator_memory_local', vecTable: 'memory_vec_local',
      embeddingModelDims: EMBEDDER_DIM_SPECS.local.targetDims,
      embeddingProfile: EMBEDDER_DIM_SPECS.local, storageProfile: MEMORY_VECTOR_STORAGE_PROFILES.local });
    // Reuse the real canonical SQL over this fixture's owned PostgreSQL client,
    // as in temporal-convergence.integration.test.ts; no mem0/embedding service.
    (store as unknown as { pool: unknown }).pool = {
      query: async (text: string, params: unknown[] = []) => {
        const rows = await db.adminSql.unsafe(text, params as never[]);
        return { rows: [...rows], rowCount: rows.count };
      }, on: () => {}, end: async () => {},
    };
  }, 120_000);
  afterAll(async () => { resetReadCursorStore(); await store?.dispose(); await db?.cleanup(); });

  it('reads only exact current-pool canonical memory IDs, including closed validity but excluding entities and archived rows', async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const scope = `memory-lifecycle:${randomUUID()}`;
    for (const [i, id] of ids.entries()) {
      const payload = { user_id: i === 1 ? 'foreign-pool' : scope, data: `private body ${i}`,
        ...(i === 2 ? { entityType: 'COMPOUND' } : {}) };
      await db.adminSql`INSERT INTO harness_shared.memory_canonical(id, payload, state, valid_at, invalid_at)
        VALUES (${id}, ${JSON.stringify(payload)}::text::jsonb, ${i === 3 ? 'archived' : 'active'},
          now() - interval '2 days', now() - interval '1 day')`;
    }
    const backend = new Mem0Backend({ getClient: async () => null,
      listPage: async (filters, topK, offset, selected) => {
        const [rows, total] = await store.listPage(filters, topK, offset, selected);
        return { rows, total };
      } });
    const selection = { scope, ids: ids.slice(0, 4), limit: 8, offset: 0 };
    expect(await backend.listPage(selection)).toEqual({ entries: [], total: 0 });
    const closed = await backend.listPage({ ...selection, includeSuperseded: true });
    expect(closed.total).toBe(1);
    expect(closed.entries).toMatchObject([{ id: ids[0], scope, text: 'private body 0',
      metadata: { validity: { status: 'superseded' } } }]);
    expect(closed.entries).toHaveLength(1);
    expect(await backend.listPage({ ...selection, scope: 'no-grant', includeSuperseded: true }))
      .toEqual({ entries: [], total: 0 });
    expect(await backend.listPage({ ...selection, ids: [], includeSuperseded: true }))
      .toEqual({ entries: [], total: 0 });
  });

  it('bounds and fairly schedules confirmed corpus revalidation without advancing delivery', async () => {
    const sql = db.adminSql as unknown as SqlTag;
    const owner = `revalidation:${randomUUID()}`;
    const versions = Array.from({ length: 10 }, (_, i) => contextSourceVersion({ namespace: 'corpus:plan:fixture',
      ref: `plan:pot:source-${i}`, fullText: `authorized ${i}`, revision: 'v1', updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } }));
    for (const version of versions) expect(await stampSurfacedRefsResult(sql, owner, 4,
      [version.ref], 'native-confirmed', version.fingerprint, version)).toEqual({ ok: true, inserted: 1 });
    const before = await db.adminSql`SELECT ref, source_fingerprint, source_version, surfaced_at
      FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner} ORDER BY ref`;
    const first = await corpusSourcesDueForRevalidation(sql, owner, 4);
    const second = await corpusSourcesDueForRevalidation(sql, owner, 4);
    expect(first).toHaveLength(8);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map(row => row.ref))).toEqual(new Set(versions.map(row => row.ref)));
    expect(await corpusSourcesDueForRevalidation(sql, owner, 4)).toEqual([]);
    expect(await corpusSourcesDueForRevalidation(sql, owner, 5)).toEqual([]);
    expect(await corpusSourcesDueForRevalidation(sql, 'other-owner', 4)).toEqual([]);
    expect(await db.adminSql`SELECT ref, source_fingerprint, source_version, surfaced_at
      FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner} ORDER BY ref`).toEqual(before);
    await db.adminSql`UPDATE harness_shared.corpus_session_surfaced SET source_checked_at = now() - interval '2 minutes'
      WHERE session_id = ${owner}`;
    expect(await corpusSourcesDueForRevalidation(sql, owner, 4, versions.map(row => row.ref))).toEqual([]);
    expect(await corpusSourcesDueForRevalidation(sql, owner, 4)).toHaveLength(8);
  });

  it('fairly schedules confirmed memory sources only in current pools and epochs without stamping delivery', async () => {
    const sql = db.adminSql as unknown as SqlTag;
    const owner = `memory-revalidation:${randomUUID()}`;
    const versions = Array.from({ length: 11 }, (_, i) => contextSourceVersion({
      namespace: i === 10 ? 'memory:foreign' : 'memory:current', ref: randomUUID(), fullText: `fact ${i}`,
      revision: 'r1', updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } }));
    for (const version of versions) expect(await stampSurfacedResult(sql, owner, 2, [version.ref],
      'native-confirmed', version.fingerprint, version)).toEqual({ ok: true, inserted: 1 });
    const snapshot = () => db.adminSql`SELECT memory_id, source_fingerprint, source_version, surfaced_at
      FROM harness_shared.memory_session_surfaced WHERE session_id = ${owner} ORDER BY memory_id`;
    const before = await snapshot();
    expect(await memorySourcesDueForRevalidation(sql, owner, 2, [])).toEqual([]);
    expect(await memorySourcesDueForRevalidation(sql, 'another-owner', 2, ['current'])).toEqual([]);
    expect(await memorySourcesDueForRevalidation(sql, owner, 3, ['current'])).toEqual([]);
    const first = await memorySourcesDueForRevalidation(sql, owner, 2, ['current']);
    const second = await memorySourcesDueForRevalidation(sql, owner, 2, ['current']);
    expect(first).toHaveLength(8); expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map(version => version.ref)))
      .toEqual(new Set(versions.slice(0, 10).map(version => version.ref)));
    expect(await memorySourcesDueForRevalidation(sql, owner, 2, ['current'])).toEqual([]);
    expect(await snapshot()).toEqual(before);
    await db.adminSql`UPDATE harness_shared.memory_session_surfaced SET source_checked_at = now() - interval '2 minutes'
      WHERE session_id = ${owner}`;
    expect(await memorySourcesDueForRevalidation(sql, owner, 2, ['current'], versions.map(version => version.ref))).toEqual([]);
    expect(await memorySourcesDueForRevalidation(sql, owner, 2, ['current'])).toHaveLength(8);
  });

  it.each(['memory', 'corpus'] as const)('allows same-epoch %s corrections and requires the exact version on confirmation', async kind => {
    const sql = db.adminSql as unknown as SqlTag;
    const owner = `version-ledger:${randomUUID()}`, id = kind === 'memory' ? randomUUID() : `doc:${randomUUID()}`;
    const read = (fingerprint: string, epoch = 3) => kind === 'memory'
      ? alreadySurfacedIds(sql, owner, epoch, [id], new Map([[id, fingerprint]]))
      : alreadySurfacedRefs(sql, owner, epoch, [id], new Map([[id, fingerprint]]));
    const stamp = kind === 'memory' ? stampSurfacedResult : stampSurfacedRefsResult;
    const storedVersion = async () => {
      const rows = kind === 'memory' ? await db.adminSql`SELECT source_version FROM harness_shared.memory_session_surfaced
        WHERE session_id = ${owner} AND epoch = 3 AND memory_id = ${id}`
        : await db.adminSql`SELECT source_version FROM harness_shared.corpus_session_surfaced
        WHERE session_id = ${owner} AND epoch = 3 AND ref = ${id}`;
      return rows[0]?.source_version ?? null;
    };
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
    // Untyped host inputs must not smuggle source text into durable receipts.
    const untyped = { ...first, extra: 'private untyped body', sourceVersion: {
      ...firstVersion, text: 'private canonical prose',
      passage: { ...firstVersion.passage, excerpt: 'private passage' },
    } };
    await stageMemoryEmission(sql, owner, 'first-version', [untyped]);
    await stageMemoryEmission(sql, owner, 'late-first-version', [first]);
    expect(await storedVersion()).toBeNull();
    expect(await read(firstVersion.fingerprint)).toEqual(new Set()); // preparation is not delivery
    const proof = { token: 'first-version', fragments: [native(first)] };
    expect(await confirmMemoryEmission(sql, owner, { ...proof,
      fragments: [{ ...native(first), sourceFingerprint: nextVersion.fingerprint }] })).toBe(0);
    expect(await confirmMemoryEmission(sql, owner, proof)).toBe(1);
    expect(await storedVersion()).toEqual(firstVersion);
    expect(JSON.stringify(await storedVersion())).not.toContain('Only after approval');
    expect(JSON.stringify(await storedVersion())).not.toContain('private');
    expect(await read(firstVersion.fingerprint)).toEqual(new Set([id]));
    expect(await read(nextVersion.fingerprint)).toEqual(new Set());
    await stageMemoryEmission(sql, owner, 'next-version', [next]);
    expect(await confirmMemoryEmission(sql, owner, { token: 'next-version', fragments: [native(next)] })).toBe(1);
    expect(await storedVersion()).toEqual(nextVersion);
    expect(await read(nextVersion.fingerprint)).toEqual(new Set([id]));
    // A legacy port cannot erase an already-versioned stamp.
    expect(await stamp(sql, owner, 3, [id], 'legacy')).toEqual({ ok: true, inserted: 0 });
    expect(await storedVersion()).toEqual(nextVersion);
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

  it.each(['memory', 'corpus'] as const)('rejects mismatched %s source metadata before stamping', async kind => {
    const sql = db.adminSql as unknown as SqlTag;
    const owner = `version-invalid:${randomUUID()}`, id = kind === 'memory' ? randomUUID() : `doc:${randomUUID()}`;
    const source = contextSourceVersion({ namespace: kind, ref: id, fullText: 'Authorized source',
      revision: null, updatedAt: null,
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const stamp = kind === 'memory' ? stampSurfacedResult : stampSurfacedRefsResult;
    expect(await stamp(sql, owner, 1, [id], 'test', 'a'.repeat(64), source)).toEqual({ ok: false, inserted: 0 });
    expect(await stamp(sql, owner, 1, [id], 'test', source.fingerprint,
      { ...source, fullTextBytes: source.fullTextBytes + 1 })).toEqual({ ok: false, inserted: 0 });
    const rows = kind === 'memory' ? await db.adminSql`SELECT memory_id FROM harness_shared.memory_session_surfaced WHERE session_id = ${owner}`
      : await db.adminSql`SELECT ref FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner}`;
    expect(rows).toHaveLength(0);
  });
});
