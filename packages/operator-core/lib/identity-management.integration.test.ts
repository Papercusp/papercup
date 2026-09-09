// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { parseSuLaunchSpecRecord } from './su-persona-render';

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

import { readIdentitySurface } from './identity-management';

const WORKSPACE = 'identity-management-schema-test';
const OWNER = 'su-identity-management-test';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('identity-management-schema');
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
