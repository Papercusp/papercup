import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { readLatestRubricCheckResults } from '../check-results-ledger';
import { perfEvidenceRepository, sealPerfEvidence } from './perf-workload-evidence';
import { perfProtocolHash } from './perf-workload-protocol';

let db: OrgTestDb;
let directory: string;
beforeAll(async () => {
  db = await createOrgTestDb();
  directory = await mkdtemp(join(tmpdir(), 'perf-evidence-pg-'));
}, 180_000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  await db?.cleanup();
});

it('retains evidence through real Postgres and files, without making integrity an acceptance grade', async () => {
  const repository = perfEvidenceRepository({ directory, sql: db.adminSql,
    scope: { workspaceId: 'perf-evidence-fixture', harnessSlug: 'papercusp' } });
  const body = { kind: 'registration' as const, protocolHash: perfProtocolHash('fixture-protocol'), registeredAtMs: Date.now() - 60_000 };
  const before = Date.now();
  const receipt = await repository.publish(body);
  expect(receipt.evidence).toMatchObject(sealPerfEvidence(body));
  expect(receipt.evidence.publishedAtMs).toBeGreaterThanOrEqual(before);
  expect(await repository.read(receipt.ref)).toEqual(receipt.evidence);
  const unscoped = await readLatestRubricCheckResults({ rubricRef: 'acceptance-host-memory-right-sizing-2026-10-31',
    workspaceId: 'perf-evidence-fixture' }, db.adminSql);
  expect(unscoped.size).toBe(0);
  const foreign = perfEvidenceRepository({ directory, sql: db.adminSql,
    scope: { workspaceId: 'other-workspace', harnessSlug: 'papercusp' } });
  expect(await foreign.read(receipt.ref)).toBeNull();
  // Exact-row refs keep resolving the earlier snapshot when a new edition is appended.
  const newer = await repository.publish({ ...body, protocolHash: perfProtocolHash('different-protocol') });
  expect(newer.ref).not.toBe(receipt.ref);
  expect(await repository.read(receipt.ref)).toEqual(receipt.evidence);
  await writeFile(receipt.artifactPath, '{}');
  expect(await repository.read(receipt.ref)).toBeNull();
}, 30_000);
