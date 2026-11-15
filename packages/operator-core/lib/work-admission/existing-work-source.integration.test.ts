import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { admitWorkItem } from './admit';
import { registerAdmissionSource, unregisterAdmissionSourceForTest } from './admission-sources';
import { createExistingWorkAdmissionSource, existingWorkAdmissionSource } from './existing-work-source';
import { correlateAdmissionStandingPr, resolveAdmissionStandingPrPaths } from './lifecycle';
import { completionHeadBlobMap } from '../agent-tools/work_items/completion-freshness';
import { decideMergeGate } from '../harness/git-sync/decide-merge-gate';

const WS = 'papercusp-workspace';
const HOME = 'papercusp';
const TARGET = 'local-review-member';
const FORK = 'https://github.com/acme-fork/subject.git';
let org: OrgTestDb;
let sql: Sql;
let seq = 0;
let review = true;
const create = vi.fn(async () => { throw new Error('adoption must not mint work'); });
const capture = vi.fn(async () => { throw new Error('adoption must not re-file bugs'); });

beforeAll(async () => {
  org = await createOrgTestDb(); sql = org.adminSql;
  unregisterAdmissionSourceForTest('work-item');
  registerAdmissionSource(createExistingWorkAdmissionSource({ prDelivery: {
    loadProjects: async () => [{ slug: TARGET, self_repo: true, fork_remote: FORK },
      { slug: TARGET + '-other', self_repo: true, fork_remote: FORK }],
    readMode: async () => ({ mode: review ? 'review' : 'direct', source: 'set' }),
  } }));
});
afterAll(async () => {
  unregisterAdmissionSourceForTest('work-item'); registerAdmissionSource(existingWorkAdmissionSource);
  await org?.cleanup();
});

async function fixture(kind = 'change', nature = 'work') {
  const id = `WI-local-adoption-${++seq}`;
  const insert = (db: Sql | TransactionSql) => db`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, nature, audience, title, summary, status, payload, created_ts, updated_ts)
    VALUES (${WS}, ${HOME}, ${id}, ${kind}, ${nature}, ${nature === 'work' ? 'agent' : null},
      'Original title', 'Original summary', 'open', ${db.json({ retained: true })}, ${Date.now()}, ${Date.now()})`;
  if (nature === 'work') await insert(sql);
  else await sql.begin(async tx => {
    // Deliberately model a non-work physical candidate in this throwaway database.
    await tx`ALTER TABLE harness_shared.work_items DISABLE TRIGGER nature_stamp_from_registry_trg`;
    await insert(tx);
    await tx`ALTER TABLE harness_shared.work_items ENABLE TRIGGER nature_stamp_from_registry_trg`;
  });
  return id;
}
async function row(id: string) {
  const [r] = await sql`SELECT * FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return r!;
}
async function admissions(id: string) {
  return sql`SELECT * FROM harness_shared.work_admissions WHERE workspace_id = ${WS} AND work_item_id = ${id}`;
}
function input(id: string) {
  return { workspaceId: WS, harness: TARGET, source: { kind: 'work-item', workItemId: id, workItemHarness: HOME, forkRemote: FORK },
    admitter: { via: 'person' as const, actorId: 'su-local-adopter' } };
}
const admit = (id: string) => admitWorkItem(input(id), { sql: sql as never, createWorkItem: create, captureBug: capture });

describe('explicit existing local-work admission', () => {
  it.each(['bug', 'change'])('adopts the same %s once across concurrent retries without changing its row', async kind => {
    const id = await fixture(kind); const before = await row(id);
    const results = await Promise.all([admit(id), admit(id), admit(id)]);
    expect(results.every(r => r.ok && r.workItemId === id)).toBe(true);
    expect(results.map(r => r.ok && r.reason).sort()).toEqual(['adopted', 'existing', 'existing']);
    const first = results[0]!;
    if (!first.ok) throw new Error(first.message);
    expect(await admitWorkItem({ ...input(id), source: { kind: 'work-item', ...first.admission.sourceRef } },
      { sql: sql as never, createWorkItem: create, captureBug: capture })).toMatchObject({ ok: true, reason: 'existing' });
    expect(await row(id)).toEqual(before);
    const rows = await admissions(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ work_item_id: id, harness_slug: TARGET, data_source_id: null, source_kind: 'work-item', admitted_by: 'su-local-adopter' });
    expect(rows[0]!.field_authority.external).toEqual([]);
    expect(create).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  });

  it.each([['task', 'work'], ['feature', 'work'], ['change', 'record'], ['change', 'document']])(
    'refuses unsupported kind/nature %s/%s', async (kind, nature) => {
      const id = await fixture(kind, nature);
      expect(await admit(id)).toMatchObject({ ok: false, code: 'existing_work_kind_invalid' });
      expect(await admissions(id)).toEqual([]);
    });

  it('fences workspace, physical home, target repository, review mode and explicit person admission', async () => {
    const id = await fixture(); const args = input(id); const deps = { sql: sql as never };
    expect(await admitWorkItem({ ...args, workspaceId: 'foreign-workspace' }, deps)).toMatchObject({ ok: false, code: 'source_not_found' });
    expect(await admitWorkItem({ ...args, source: { ...args.source, workItemHarness: 'wrong-home' } }, deps)).toMatchObject({ ok: false, code: 'existing_work_home_conflict' });
    expect(await admitWorkItem({ ...args, source: { ...args.source, forkRemote: 'https://github.com/other/repo' } }, deps)).toMatchObject({ ok: false, code: 'existing_work_route_conflict' });
    expect(await admitWorkItem({ ...args, harness: 'unregistered-target' }, deps)).toMatchObject({ ok: false, code: 'pr_delivery_unknown_harness' });
    expect(await admitWorkItem({ ...args, title: 'replacement' }, deps)).toMatchObject({ ok: false, code: 'existing_work_invalid' });
    expect(await admitWorkItem({ ...args, kind: 'bug' }, deps)).toMatchObject({ ok: false, code: 'existing_work_invalid' });
    expect(await admitWorkItem({ ...args, admitter: { via: 'rule', ruleId: 'rule', dataSourceId: 'source' } }, deps)).toMatchObject({ ok: false, code: 'existing_work_requires_person' });
    review = false;
    try { expect(await admit(id)).toMatchObject({ ok: false, code: 'pr_delivery_requires_review_mode' }); }
    finally { review = true; }
    expect(await admissions(id)).toEqual([]);
  });

  it('cannot retarget local attribution or adopt an already attributed provider item', async () => {
    const id = await fixture(); await admit(id);
    expect(await admitWorkItem({ ...input(id), harness: TARGET + '-other' }, { sql: sql as never }))
      .toMatchObject({ ok: false, code: 'existing_work_attribution_conflict' });
    const provider = await fixture();
    await sql`INSERT INTO harness_shared.work_admissions
      (workspace_id, work_item_id, harness_slug, source_kind, source_key, source_ref, field_authority, admitted_via, admitted_by)
      VALUES (${WS}, ${provider}, ${TARGET}, 'record', ${provider}, ${sql.json({ recordId: provider })},
        ${sql.json({ external: ['title'], papercusp: ['status'] })}, 'person', 'provider-admitter')`;
    expect(await admit(provider)).toMatchObject({ ok: false, code: 'existing_work_attribution_conflict' });
    expect(await admissions(provider)).toHaveLength(1);
  });

  it('uses the full physical census and refuses ambiguous homes without writing siblings', async () => {
    const id = await fixture();
    await sql.begin(async tx => {
      await tx`DROP INDEX harness_shared.work_items_workspace_feature_id_uq`;
      await tx`ALTER TABLE harness_shared.work_items DISABLE TRIGGER nature_stamp_from_registry_trg`;
      await tx`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, nature, audience, title, status, payload, created_ts, updated_ts)
        VALUES (${WS}, 'legacy-twin', ${id}, 'change', 'record', null, 'Record twin', 'open', '{}', ${Date.now()}, ${Date.now()})`;
      await tx`ALTER TABLE harness_shared.work_items ENABLE TRIGGER nature_stamp_from_registry_trg`;
      const args = input(id);
      expect(await admitWorkItem({ ...args, source: { ...args.source, workItemHarness: 'neither-home' } }, { sql: Object.assign(tx, { begin: tx.savepoint.bind(tx) }) as never }))
        .toMatchObject({ ok: false, code: 'work_item_id_ambiguous' });
      expect(await tx`SELECT * FROM harness_shared.work_admissions WHERE work_item_id = ${id}`).toEqual([]);
      await tx`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${id} AND harness_slug = 'legacy-twin'`;
      await tx`CREATE UNIQUE INDEX work_items_workspace_feature_id_uq ON harness_shared.work_items (workspace_id, feature_id)`;
    });
  });
});

it('qualifies only independently committed local-change blobs for the exact PR/current target and merge gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-admission-pr-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Local admission test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'fix.txt'), 'broken\n'); git('add', '.'); git('commit', '-qm', 'independent baseline');
    const target = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'fix.txt'), 'fixed\n'); git('add', '.'); git('commit', '-qm', 'independent fix');
    const head = git('rev-parse', 'HEAD'); const blob = git('rev-parse', 'HEAD:fix.txt');
    const id = await fixture(); await admit(id);
    const payload = { retained: true, _completionEvidence: { summary: 'Independent fix', settlementManifest: {
      version: 1, generation: 1, evidenceHash: 'c'.repeat(64), repositoryRoot: root, headSha: head,
      normalizedPaths: ['fix.txt'], contentIdentity: [{ path: 'fix.txt', workingTreeBlobSha: blob, headBlobSha: blob }], residualPaths: [],
    } } };
    const publication = { workspaceId: WS, harnesses: [TARGET], repositoryRoot: root, testedSha: head,
      targetSha: target, url: 'https://github.com/acme/subject/pull/9', number: 9 };
    const set = async (status: string, authority: string, p: object = payload) => {
      await sql`UPDATE harness_shared.work_items SET status = ${status}, authority = ${authority}, payload = ${sql.json(p)}
        WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    };
    for (const [status, authority] of [['open', 'committed'], ['done', 'proposed']]) {
      await set(status!, authority!);
      expect(await correlateAdmissionStandingPr(sql, publication)).toEqual({ linked: [], failed: [] });
    }
    await set('done', 'committed');
    expect(await correlateAdmissionStandingPr(sql, { ...publication, expectedPayload: { stale: true } })).toEqual({ linked: [], failed: [] });
    let changed = false;
    expect(await correlateAdmissionStandingPr(sql, publication, { headBlobs: async (...args) => {
      if (!changed) { changed = true; await set('open', 'committed'); }
      return completionHeadBlobMap(...args);
    } })).toMatchObject({ linked: [], failed: [{ workItemId: id, error: expect.stringContaining('completion changed') }] });
    await set('done', 'committed');
    expect(await correlateAdmissionStandingPr(sql, publication)).toEqual({ linked: [id], failed: [] });
    const allowed = await resolveAdmissionStandingPrPaths(sql, publication);
    expect(allowed).toEqual({ ok: true, paths: ['fix.txt'], workItemIds: [id] });
    for (const extra of [{ number: 10 }, { url: 'https://github.com/acme/subject/pull/10' }, { testedSha: target }, { targetSha: head }]) {
      expect(await resolveAdmissionStandingPrPaths(sql, { ...publication, ...extra })).toEqual({ ok: true, paths: [], workItemIds: [] });
    }
    const gate = { prHeadSha: head, promotedSha: head, targetTipSha: target,
      lastTest: { mergeSha: head, prHeadSha: head, targetTipSha: target, result: 'pass' as const },
      submodulePins: { ok: true as const, unpublished: [] } };
    expect(decideMergeGate({ ...gate, pathAttribution: { ok: true, prDiffPaths: ['fix.txt'], admittedFixPaths: allowed.ok ? allowed.paths : [] } })).toMatchObject({ action: 'merge' });
    expect(decideMergeGate({ ...gate, pathAttribution: { ok: true, prDiffPaths: ['fix.txt', 'unattributed.txt'], admittedFixPaths: ['fix.txt'] } })).toMatchObject({ action: 'refuse', reason: 'unattributed-delta' });
    for (const settlementManifest of [{}, { ...payload._completionEvidence.settlementManifest, residualPaths: ['residue.txt'] },
      { ...payload._completionEvidence.settlementManifest, contentIdentity: [{ path: 'fix.txt', workingTreeBlobSha: 'a'.repeat(40) }] },
      { ...payload._completionEvidence.settlementManifest, contentIdentity: [{ path: 'fix.txt', deletion: true }] }]) {
      await set('done', 'committed', { ...payload, _completionEvidence: { ...payload._completionEvidence, settlementManifest } });
      expect((await correlateAdmissionStandingPr(sql, publication)).linked).toEqual([]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
