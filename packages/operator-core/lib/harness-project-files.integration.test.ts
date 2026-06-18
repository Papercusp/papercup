/**
 * harness-project-files.integration.test.ts — the per-harness SPEC/AGENTS/
 * contract/config store (migration 034), against a real Postgres (testcontainer).
 *
 * The behavior that needs real PG (a fake-sql unit test can't reach it): the
 * optimistic-concurrency control. saveProjectFiles with `expectedVersion` does a
 * version-guarded UPDATE and throws ProjectFilesVersionConflict when the row
 * moved on — plus the no-OCC upsert that COALESCE-preserves omitted fields and
 * bumps `version`. Mirrors autoloop-state.integration.test.ts's harness.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { loadProjectFiles, saveProjectFiles, ProjectFilesVersionConflict } = await import('./harness-project-files');

const SLUG = 'web';
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `hpf_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // The harness_project_files shape (migration 034) — PK on harness_slug.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_project_files (
      harness_slug text PRIMARY KEY,
      spec text,
      agents text,
      contract text,
      config text,
      updated_at bigint NOT NULL,
      version integer NOT NULL DEFAULT 0
    )
  `);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('harness-project-files store (PG)', () => {
  it('loadProjectFiles returns the empty default for an unknown harness', async () => {
    expect(await loadProjectFiles('nobody')).toEqual({
      spec: null, agents: null, contract: null, config: null, version: 0,
    });
  });

  it('saveProjectFiles (no OCC) inserts at version 1 and reads back', async () => {
    expect(await saveProjectFiles(SLUG, { spec: 'S1', agents: 'A1' })).toEqual({ version: 1 });
    expect(await loadProjectFiles(SLUG)).toMatchObject({ spec: 'S1', agents: 'A1', contract: null, config: null, version: 1 });
  });

  it('saveProjectFiles (no OCC) upserts: bumps version + COALESCE preserves omitted fields', async () => {
    expect(await saveProjectFiles(SLUG, { contract: 'C1' })).toEqual({ version: 2 }); // only contract
    expect(await loadProjectFiles(SLUG)).toMatchObject({ spec: 'S1', agents: 'A1', contract: 'C1', version: 2 });
  });

  it('OCC: a matching expectedVersion updates and bumps the version', async () => {
    expect(await saveProjectFiles(SLUG, { config: 'cfg' }, { expectedVersion: 2 })).toEqual({ version: 3 });
    expect(await loadProjectFiles(SLUG)).toMatchObject({ config: 'cfg', version: 3 });
  });

  it('OCC: a STALE expectedVersion throws ProjectFilesVersionConflict (carrying the current version) and does NOT apply', async () => {
    let err: unknown;
    try {
      await saveProjectFiles(SLUG, { spec: 'STALE-WRITE' }, { expectedVersion: 1 }); // current is 3
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectFilesVersionConflict);
    expect((err as InstanceType<typeof ProjectFilesVersionConflict>).currentVersion).toBe(3);
    expect((await loadProjectFiles(SLUG)).spec).toBe('S1'); // the stale write was rejected
  });

  it('OCC: expectedVersion 0 on a brand-new harness inserts at version 1', async () => {
    expect(await saveProjectFiles('fresh-slug', { spec: 'NEW' }, { expectedVersion: 0 })).toEqual({ version: 1 });
    expect(await loadProjectFiles('fresh-slug')).toMatchObject({ spec: 'NEW', version: 1 });
  });
});
