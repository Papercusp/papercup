/**
 * Integration test for the federated-presence query (Phase 0.3,
 * distributed-coordination-shared-harness-2026-06-04) against a real Postgres
 * shared_presence table. Proves the canonical SQL extracts the right columns +
 * epoch-ms last_seen, and the workspace/harness filters work end-to-end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { queryFederatedPresenceRows, mapSharedPresenceRow } from './federated-presence';

describe('federated-presence query (real shared_presence)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('fed_presence');
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.shared_presence (
        workspace_id   text NOT NULL DEFAULT '',
        harness_slug   text NOT NULL,
        github_user_id bigint NOT NULL,
        machine_label  text NOT NULL,
        device_pubkey  text NOT NULL,
        intent         text,
        current_view   text,
        last_seen_at   timestamptz NOT NULL DEFAULT now(),
        schema_version bigint NOT NULL DEFAULT 1,
        PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label)
      )`);
    await db.sql`
      INSERT INTO harness_shared.shared_presence
        (workspace_id, harness_slug, github_user_id, machine_label, device_pubkey, intent, current_view, last_seen_at)
      VALUES
        ('ws-1', 'papercup', 4242, 'thinkpad', 'pubAAA', 'reviewing', 'harness/papercup', now() - make_interval(secs => 5)),
        ('ws-2', 'papercup', 99,   'macmini',  'pubBBB', NULL, NULL, now() - make_interval(secs => 30))`;
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  it('reads shared_presence rows with epoch-ms last_seen + maps to unified records', async () => {
    const rows = await queryFederatedPresenceRows(db.sql as never);
    expect(rows).toHaveLength(2);
    const byUser = Object.fromEntries(rows.map((r) => [r.github_user_id, r]));
    expect(byUser[4242].machine_label).toBe('thinkpad');
    expect(byUser[4242].device_pubkey).toBe('pubAAA');
    expect(byUser[4242].intent).toBe('reviewing');
    expect(typeof byUser[4242].last_seen_ms).toBe('number');
    expect(byUser[4242].last_seen_ms).toBeGreaterThan(0);
    expect(byUser[99].intent).toBeNull();

    const now = byUser[4242].last_seen_ms + 5_000;
    const rec = mapSharedPresenceRow(byUser[4242], { now, staleMs: 600_000 });
    expect(rec.ownerId).toBe('fed:4242@thinkpad');
    expect(rec.federated).toBe(true);
    expect(rec.stale).toBe(false);
  });

  it('filters by workspace', async () => {
    const r = await queryFederatedPresenceRows(db.sql as never, { workspaceId: 'ws-1' });
    expect(r.map((x) => x.github_user_id)).toEqual([4242]);
  });
});
