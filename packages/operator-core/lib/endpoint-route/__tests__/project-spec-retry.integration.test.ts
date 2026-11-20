import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { activeWorkspaceId } from '../../workspace-registry';
import type { RouteContext } from '../define-route';
import projectRoutes from '../routes/projects';

const slug = 'spec-retry';
const id = 'spec-retry-project';
const path = '/harness/:slug/projects/:id';
const params = { slug, id };
const root = 'http://localhost/api/harness/' + slug + '/projects/' + id;
let db: OrgTestDb;
let fixture: BaselineCoordFixture;

beforeAll(async () => {
  db = await createOrgTestDb();
  fixture = await setupBaselineCoordFixture({ dsn: db.adminDsn });
  vi.stubEnv('PAPERCUSP_HARNESS_DB_POOL_MAX', '4');
  // A legacy project can have current text before it has a manual revision.
  await db.adminSql`INSERT INTO harness_shared.projects (id, name, status, spec, created_ts, updated_ts, workspace_id)
    VALUES (${id}, 'Spec retry', 'active', 'First', 1, 1, ${activeWorkspaceId()})`;
}, 120_000);

afterAll(async () => {
  try { await fixture?.dispose(); } finally {
    vi.unstubAllEnvs();
    await db?.cleanup();
  }
});

async function request(method: 'GET' | 'PUT', suffix: string, body?: { spec: string; summary: string; author: string }) {
  const route = projectRoutes.find(entry => entry.method === method && entry.path === path + suffix);
  if (!route) throw new Error('Missing registered project route ' + method + ' ' + suffix);
  const ctx: RouteContext = { principal: null, input: undefined, params, log: () => {}, signal: new AbortController().signal };
  const res = await route.handler(new Request(root + suffix, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), ctx);
  const result = await res.json();
  expect(res.status, JSON.stringify(result)).toBe(200);
  return result;
}

it('keeps the original edition and author under concurrent PUT retries and records a later return to earlier text', async () => {
  const first = { spec: 'First', summary: 'Original edition', author: 'Alice' };
  const second = { spec: 'Second', summary: 'New edition', author: 'Bob' };
  const save = (body: typeof first) => request('PUT', '/spec', body);
  const history = async () => (await request('GET', '/spec/revisions')).revisions;
  const detail = () => request('GET', '');
  await Promise.all([save(first), save(first)]);
  const original = await history();
  expect(original).toHaveLength(1);
  expect(original[0]).toMatchObject({ summary: first.summary, author: first.author });
  const originalProject = await detail();
  expect(originalProject).toMatchObject({ spec: first.spec, last_spec_revision: { id: original[0].id } });
  await save(first);
  expect(await detail()).toEqual(originalProject);
  expect(await history()).toEqual(original);
  await save(second);
  const changed = await history();
  expect(changed).toEqual([expect.objectContaining({ summary: second.summary, author: second.author }), ...original]);
  expect(await detail()).toMatchObject({ spec: second.spec, last_spec_revision: { id: changed[0].id } });
  await save(first);
  const restored = await history();
  expect(restored).toEqual([expect.objectContaining({ summary: first.summary, author: first.author }), ...changed]);
  expect(restored[0].id).not.toBe(original[0].id);
  expect(await detail()).toMatchObject({ spec: first.spec, last_spec_revision: { id: restored[0].id } });
  const reviewed = { ...first, author: 'Carol', summary: 'Reviewed original text' };
  await save(reviewed);
  const reviewedHistory = await history();
  expect(reviewedHistory).toEqual([expect.objectContaining({ author: reviewed.author, summary: reviewed.summary }), ...restored]);
  await save(reviewed);
  expect(await history()).toEqual(reviewedHistory);
});
