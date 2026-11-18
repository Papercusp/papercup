// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { parseSuLaunchSpecRecord } from './su-persona-render';

const mutationHost = vi.hoisted(() => ({
  sql: null as import('postgres').Sql | null,
  rebuild: vi.fn<typeof import('./su-persona-render').rebuildSuLaunchArtifact>(),
  provision: vi.fn<typeof import('./role-launch-spec').provisionLaunchIdentityResources>(),
  activate: vi.fn<typeof import('./agent-tools/coordination/control-anchor').requestSessionIdentityActivationInTransaction>(),
  funded: vi.fn(async () => {}),
}));

vi.mock('@papercusp/db-org', async original => ({
  ...(await original<object>()), getOrgPg: () => ({ sql: mutationHost.sql }),
}));
vi.mock('./su-persona-render', async original => ({
  ...(await original<object>()), rebuildSuLaunchArtifact: mutationHost.rebuild,
}));
vi.mock('./role-launch-spec', async original => ({
  ...(await original<object>()), provisionLaunchIdentityResources: mutationHost.provision,
}));
vi.mock('./agent-tools/coordination/control-anchor', () => ({
  requestSessionIdentityActivationInTransaction: mutationHost.activate,
}));
vi.mock('./cupboard/identity-activation-gate-io', () => ({
  assertIdentityActivationFunded: mutationHost.funded,
}));
vi.mock('./events/await/psu-pty-discovery', () => ({ findLiveHostAsync: async () => null }));

vi.mock('./agent-identities/source', () => ({
  listIdentitySources: vi.fn(async () => ({
    ok: true,
    identities: [],
    unreadable: [],
    count: 0,
    scanned: 0,
    nextAfter: null,
  })),
  getIdentitySource: vi.fn(),
}));

vi.mock('./spawn-config', () => ({
  resolveProjectDir: vi.fn(async () => null),
}));

import { mutateIdentityStack, readIdentitySurface } from './identity-management';

const WORKSPACE = 'identity-management-schema-test';
const OWNER = 'su-identity-management-test';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('identity-management-schema');
  mutationHost.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigint PRIMARY KEY,
      workspace_id text NOT NULL,
      mode text NOT NULL,
      coord_owner_id text,
      launch_spec jsonb,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      ended_by text
    );
    CREATE TABLE harness_shared.session_briefs (
      owner_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      control_state jsonb
    );
    CREATE TABLE harness_shared.session_identity_activation_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      owner_id text NOT NULL,
      phase text NOT NULL,
      source text NOT NULL,
      specification_revision text NOT NULL,
      state_revision text NOT NULL,
      stack_refs jsonb NOT NULL,
      failure text,
      recorded_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE harness_shared.identity_mutation_effects (target text NOT NULL);
  `);
  await db.sql`
    INSERT INTO harness_shared.adv_sessions
      (id, workspace_id, mode, coord_owner_id, launch_spec)
    VALUES (
      1,
      ${WORKSPACE},
      'console',
      ${OWNER},
      ${db.sql.json({
        v: 1,
        agent: 'codex',
        workspaceId: WORKSPACE,
        harnessSlug: 'schema-test-harness',
        contextSize: 'trimmed',
      })}
    )
  `;
}, 90_000);

afterAll(async () => db?.cleanup(), 300_000);

describe('identity management live-schema contract', () => {
  it.each([false, true])('reads the latest registration after predecessor activity (successor ended=%s)', async (ended) => {
    const owner = `${OWNER}-registration-${ended}`;
    const oldId = ended ? 20 : 10;
    const spec = { v: 1, agent: 'codex', workspaceId: WORKSPACE, contextSize: 'trimmed' };
    await db.sql`
      INSERT INTO harness_shared.adv_sessions (id, workspace_id, mode, coord_owner_id, launch_spec, started_at, ended_at)
      VALUES (${oldId}, ${WORKSPACE}, 'console', ${owner},
              ${db.sql.json({ ...spec, stack: ['domain:predecessor'] })}, now() + interval '1 hour', NULL),
             (${oldId + 1}, ${WORKSPACE}, 'console', ${owner},
              ${db.sql.json({ ...spec, stack: ['domain:successor'] })}, now() - interval '1 hour',
              ${ended ? new Date() : null})`;
    const surface = await readIdentitySurface({ workspaceId: WORKSPACE, ownerId: owner, sql: db.sql });
    expect(surface.session?.explicitStack).toEqual(['domain:successor']);
  });

  it('reads the authoritative launch-spec harness from adv_sessions without a physical harness_slug column', async () => {
    const [stored] = await db.sql<Array<{ launch_spec: unknown }>>`
      SELECT to_jsonb(a)->'launch_spec' AS launch_spec
        FROM harness_shared.adv_sessions a
       WHERE workspace_id = ${WORKSPACE} AND coord_owner_id = ${OWNER}
    `;
    expect(stored?.launch_spec).toEqual(expect.objectContaining({ harnessSlug: 'schema-test-harness' }));
    expect(parseSuLaunchSpecRecord(stored?.launch_spec)).toMatchObject({
      agent: 'codex',
      harnessSlug: 'schema-test-harness',
    });

    const surface = await readIdentitySurface({
      workspaceId: WORKSPACE,
      ownerId: OWNER,
      sql: db.sql,
    });

    expect(surface.session).toMatchObject({
      ownerId: OWNER,
      agent: 'codex',
      harnessSlug: 'schema-test-harness',
    });
  });

  it('keeps every identity-management adv_sessions reader off the nonexistent physical column', () => {
    const source = readFileSync(new URL('./identity-management.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('a.harness_slug');
    expect(source.match(/to_jsonb\(a\)->'launch_spec'/g)).toHaveLength(2);
  });
});

describe('identity mutation before-image fence', () => {
  const owner = OWNER + '-mutation';
  const beforeRevision = 'a'.repeat(64);
  const afterRevision = 'b'.repeat(64);
  const input = { workspaceId: WORKSPACE, ownerId: owner, action: 'rollback' as const,
    operatorBaseUrl: 'http://operator.test', modeSection: '' };
  const original = { v: 1, agent: 'codex', workspaceId: WORKSPACE, contextSize: 'trimmed',
    stack: ['domain:current'], specificationRevision: beforeRevision, stateRevision: 'before',
    specificationArtifact: { specificationRevision: beforeRevision, configuration: {}, inputs: [] },
    identityHistory: [{ stack: ['domain:prior'], specificationRevision: afterRevision, stateRevision: 'prior',
      recordedAt: '2026-01-01T00:00:00Z',
      specificationArtifact: { specificationRevision: afterRevision, configuration: {}, inputs: [] } }] };
  const rebuilt = { artifact: { stack: ['domain:prior'], specificationRevision: afterRevision,
    stateRevision: 'after', resourceArtifacts: [],
    specificationArtifact: { specificationRevision: afterRevision, configuration: {}, inputs: [] } } } as
    unknown as Awaited<ReturnType<typeof import('./su-persona-render').rebuildSuLaunchArtifact>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mutationHost.rebuild.mockReset().mockResolvedValue(rebuilt);
    mutationHost.provision.mockReset().mockImplementation(async () => {
      await db.sql`INSERT INTO harness_shared.identity_mutation_effects VALUES (${afterRevision})`;
    });
    mutationHost.activate.mockReset().mockResolvedValue({ state: {} } as
      Awaited<ReturnType<typeof import('./agent-tools/coordination/control-anchor').requestSessionIdentityActivationInTransaction>>);
    await db.sql`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id = ${owner}`;
    await db.sql`TRUNCATE harness_shared.identity_mutation_effects`;
    await db.sql`INSERT INTO harness_shared.adv_sessions (id, workspace_id, mode, coord_owner_id, launch_spec)
      VALUES (100, ${WORKSPACE}, 'console', ${owner}, ${db.sql.json(original)})`;
  });

  it('refuses a stale compiled edit before provisioning or publishing activation', async () => {
    const concurrent = { ...original, stateRevision: 'concurrent' };
    mutationHost.rebuild.mockImplementationOnce(async () => {
      await db.sql`UPDATE harness_shared.adv_sessions SET launch_spec = ${db.sql.json(concurrent)} WHERE id = 100`;
      return rebuilt;
    });
    await expect(mutateIdentityStack(input)).rejects.toThrow('changed concurrently');
    expect(mutationHost.provision).not.toHaveBeenCalled();
    expect(mutationHost.activate).not.toHaveBeenCalled();
    expect(await db.sql`SELECT * FROM harness_shared.identity_mutation_effects`).toEqual([]);
    const [row] = await db.sql`SELECT launch_spec FROM harness_shared.adv_sessions WHERE id = 100`;
    expect(row!.launch_spec).toEqual(concurrent);
  });

  it('holds the session row against another writer throughout provisioning', async () => {
    mutationHost.provision.mockImplementationOnce(async () => {
      // A separate real connection must fail NOWAIT while the mutation owns
      // the row. This detects a released fence as well as a missing fence.
      await expect(db.sql.begin(async tx => {
        await tx`SELECT id FROM harness_shared.adv_sessions WHERE id = 100 FOR UPDATE NOWAIT`;
      })).rejects.toMatchObject({ code: '55P03' });
      const [row] = await db.sql`SELECT launch_spec FROM harness_shared.adv_sessions WHERE id = 100`;
      expect(row!.launch_spec).toEqual(original);
      await db.sql`INSERT INTO harness_shared.identity_mutation_effects VALUES (${afterRevision})`;
    });
    await expect(mutateIdentityStack(input)).resolves.toMatchObject({ ok: true, changed: true,
      specificationRevision: afterRevision, stateRevision: 'after' });
    expect(mutationHost.provision).toHaveBeenCalledTimes(1);
    expect(mutationHost.activate).toHaveBeenCalledTimes(1);
    expect(await db.sql`SELECT * FROM harness_shared.identity_mutation_effects`).toEqual([{ target: afterRevision }]);
    const [row] = await db.sql`SELECT launch_spec FROM harness_shared.adv_sessions WHERE id = 100`;
    expect(row!.launch_spec).toMatchObject({ specificationRevision: afterRevision, stateRevision: 'after' });
    await db.sql.begin(async tx => {
      await tx`SELECT id FROM harness_shared.adv_sessions WHERE id = 100 FOR UPDATE NOWAIT`;
    });
  });

  it('keeps the before-image and releases its fence when preparation fails', async () => {
    mutationHost.provision.mockRejectedValueOnce(new Error('package preparation refused'));
    await expect(mutateIdentityStack(input)).rejects.toThrow('package preparation refused');
    expect(mutationHost.activate).not.toHaveBeenCalled();
    const [row] = await db.sql`SELECT launch_spec FROM harness_shared.adv_sessions WHERE id = 100`;
    expect(row!.launch_spec).toEqual(original);
    await db.sql.begin(async tx => {
      await tx`SELECT id FROM harness_shared.adv_sessions WHERE id = 100 FOR UPDATE NOWAIT`;
    });
  });
});
