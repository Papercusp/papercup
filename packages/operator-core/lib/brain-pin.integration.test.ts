/**
 * brain-pin.integration.test.ts — the canonical BRAIN session pointer
 * (`harness_shared.operator_settings` key `brain_session_id:<workspaceId>`,
 * workspace-scoped per EI-908) against real Postgres. The desktop chat dock
 * resumes exactly this native uuid on launch, so the upsert-one-row /
 * read-or-null contract — and per-workspace isolation — is worth a real-schema test.
 *
 * Routes through `getOrgPg().sql` (raw postgres-js), mocked to the fixture's
 * admin client — the established org-fixture pattern.
 *
 * Validates: set→get round-trip, upsert (last write wins, one row), unset reads
 * null, and a whitespace-only / empty value reads back as null (the `.trim() || null`).
 *
 * Part of whole-app-test-coverage-breadth-2026-06-14 P-006 (integration tier).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));

const { setBrainSession, getBrainSession, brainSessionKey } = await import('./brain-pin');
const { createOrgTestDb } = await import('../test/_org-test-db');

// EI-908: the pin is workspace-scoped (key `brain_session_id:<workspaceId>`), so
// every test operates against an explicit workspace.
const WS = 'ws-brain-test';

describe('brain-pin (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  // Each test re-keys via the same scoped row; clear between for isolation.
  // Also drop the legacy unscoped row so the migrate-on-read path can't adopt a
  // stray value into this workspace mid-suite.
  async function clearPin() {
    await db.adminSql`
      DELETE FROM harness_shared.operator_settings
      WHERE key IN (${brainSessionKey(WS)}, 'brain_session_id')`;
  }

  it('reads null when no brain is pinned', async () => {
    await clearPin();
    expect(await getBrainSession(WS)).toBeNull();
  });

  it('pins a native session uuid and reads it back', async () => {
    await clearPin();
    await setBrainSession(WS, 'sess-abc-123');
    expect(await getBrainSession(WS)).toBe('sess-abc-123');
  });

  it('upsert is last-write-wins on the single scoped row', async () => {
    await clearPin();
    await setBrainSession(WS, 'sess-first');
    await setBrainSession(WS, 'sess-second');
    expect(await getBrainSession(WS)).toBe('sess-second');
    const rows = await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.operator_settings WHERE key = ${brainSessionKey(WS)}`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('a whitespace-only pinned value reads back as null', async () => {
    await clearPin();
    await setBrainSession(WS, '   ');
    expect(await getBrainSession(WS)).toBeNull();
  });

  it('EI-908: a different workspace cannot clobber another workspace pin', async () => {
    const OTHER = 'ws-demo-instance';
    await db.adminSql`
      DELETE FROM harness_shared.operator_settings
      WHERE key IN (${brainSessionKey(WS)}, ${brainSessionKey(OTHER)}, 'brain_session_id')`;
    await setBrainSession(WS, 'desktop-queen');
    await setBrainSession(OTHER, 'demo-instance'); // the launch that used to overwrite the global row
    // Each workspace still resolves its OWN pin — the demo never clobbers desktop.
    expect(await getBrainSession(WS)).toBe('desktop-queen');
    expect(await getBrainSession(OTHER)).toBe('demo-instance');
    await db.adminSql`DELETE FROM harness_shared.operator_settings WHERE key = ${brainSessionKey(OTHER)}`;
  });
});
