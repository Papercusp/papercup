/**
 * drain-loop.integration.test.ts (plan harness-state-storage-unification, P-003b).
 * Real testcontainer PG. Proves startGitExportDrain's three paths:
 *   catch-up (backlog on start), LISTEN/NOTIFY (write after start), clean stop().
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { ensureGitExportOutbox, attachGitCaptureTrigger } from './ensure-git-outbox';
import { startGitExportDrain, type GitExportDrainHandle } from './drainer';
import { gitFilePath } from './serialize';

const WS = 'ws_loop';
const SLUG = 'looph';

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}
const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};
const decisionFile = (id: string) => join(root, gitFilePath('harness_decisions', id));

let root: string;

describe('git-export drain loop (P-003b): startGitExportDrain', () => {
  let db: FreshPgDb;
  let handle: GitExportDrainHandle | null = null;

  beforeAll(async () => {
    db = await createFreshPgDb('git_export_loop');
    root = await mkdtemp(join(tmpdir(), 'git-export-loop-'));
    await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_decisions (
        id TEXT PRIMARY KEY, workspace_id TEXT, harness_slug TEXT, origin TEXT, content TEXT, ts BIGINT
      )`);
    await ensureGitExportOutbox(db.sql);
    await attachGitCaptureTrigger(db.sql, 'harness_decisions', ['id']);
  }, 90_000);

  afterEach(async () => {
    await handle?.stop();
    handle = null;
  });
  afterAll(async () => {
    await db?.cleanup();
  });

  it('catch-up: drains a pre-existing backlog on start', async () => {
    await db.sql`INSERT INTO harness_shared.harness_decisions (id, workspace_id, harness_slug, origin, content, ts)
      VALUES ('D-catchup', ${WS}, ${SLUG}, 'local', 'x', 1)`;
    handle = startGitExportDrain({ sql: db.sql, workspaceId: WS, harnessSlug: SLUG, harnessRoot: root, pollMs: 0 });
    await waitFor(() => fileExists(decisionFile('D-catchup')));
  });

  it('NOTIFY: drains a write that arrives after start (LISTEN path, poll disabled)', async () => {
    handle = startGitExportDrain({ sql: db.sql, workspaceId: WS, harnessSlug: SLUG, harnessRoot: root, pollMs: 0 });
    await new Promise((r) => setTimeout(r, 150)); // let the LISTEN connection establish
    await db.sql`INSERT INTO harness_shared.harness_decisions (id, workspace_id, harness_slug, origin, content, ts)
      VALUES ('D-notify', ${WS}, ${SLUG}, 'local', 'y', 2)`;
    await waitFor(() => fileExists(decisionFile('D-notify')));
  });

  it('stop() is clean + idempotent', async () => {
    handle = startGitExportDrain({ sql: db.sql, workspaceId: WS, harnessSlug: SLUG, harnessRoot: root, pollMs: 0 });
    await handle.stop();
    await expect(handle.stop()).resolves.toBeUndefined(); // second stop must not throw
  });
});
