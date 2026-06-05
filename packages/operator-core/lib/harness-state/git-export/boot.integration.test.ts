/**
 * boot.integration.test.ts (plan harness-state-storage-unification, P-003b).
 * Real testcontainer PG. Verifies the boot ORCHESTRATION
 * (`bootGitExportForHarnesses`): attach globals + introspect PKs, hydrate
 * pre-existing `.papercusp/state` files on boot (clone-and-go), and start the
 * per-harness drain loop. Uses the realistic harness_decisions schema (composite
 * PK (harness_slug, line_hash)) so it exercises the real GIT_KEY_COLS.
 *
 * (Only the host-bootstrap enumeration glue — readRegistry/loadHarnessRegistry —
 * is left unverified; this proves everything bootGitExportForHarnesses does.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { bootGitExportForHarnesses, type BootGitExportResult } from './boot';
import { gitFilePath, serializeRow } from './serialize';

const WS = 'ws_boot';
const SLUG = 'booth';

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(pred: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe('git-export boot orchestration (P-003b draft): bootGitExportForHarnesses', () => {
  let db: FreshPgDb;
  let root: string;
  let res: BootGitExportResult | null = null;

  beforeAll(async () => {
    db = await createFreshPgDb('git_export_boot');
    root = await mkdtemp(join(tmpdir(), 'git-export-boot-'));
    await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
    // realistic decisions schema: composite PK (harness_slug, line_hash) → GIT_KEY_COLS=['line_hash']
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_decisions (
        harness_slug TEXT, line_hash TEXT, workspace_id TEXT, origin TEXT,
        title TEXT, content TEXT, ts BIGINT,
        PRIMARY KEY (harness_slug, line_hash)
      )`);
    // pre-seed a committed file so hydrate-on-boot restores it (clone-and-go)
    const pre = join(root, gitFilePath('harness_decisions', 'abc'));
    await mkdir(dirname(pre), { recursive: true });
    await writeFile(pre, serializeRow('harness_decisions', { line_hash: 'abc', title: 'pre', content: 'hello' }), 'utf8');
  }, 90_000);

  afterAll(async () => {
    for (const h of res?.handles ?? []) await h.stop();
    await db?.cleanup();
  });

  it('attaches globals (real PKs), hydrates pre-existing files, starts a drain loop', async () => {
    res = await bootGitExportForHarnesses(db.sql, [{ workspaceId: WS, harnessSlug: SLUG, harnessRoot: root }]);
    expect(res.globals.attached).toContain('harness_decisions');
    expect(res.globals.pkByTable.get('harness_decisions')).toEqual(['harness_slug', 'line_hash']);
    expect(res.handles.length).toBe(1);

    // hydrate-on-boot restored the pre-seeded file into PG, context re-injected
    const row = await db.sql<
      { line_hash: string; title: string; content: string; harness_slug: string; workspace_id: string; origin: string }[]
    >`SELECT line_hash, title, content, harness_slug, workspace_id, origin
        FROM harness_shared.harness_decisions WHERE line_hash = 'abc'`;
    expect(row[0]).toMatchObject({
      line_hash: 'abc', title: 'pre', content: 'hello',
      harness_slug: SLUG, workspace_id: WS, origin: 'remote',
    });
  });

  it('the started loop exports a subsequent local write (PG→file via NOTIFY)', async () => {
    await new Promise((r) => setTimeout(r, 150)); // LISTEN established during boot
    await db.sql`
      INSERT INTO harness_shared.harness_decisions (harness_slug, line_hash, workspace_id, origin, title, content, ts)
      VALUES (${SLUG}, 'live1', ${WS}, 'local', 'L', 'z', 9)`;
    await waitFor(() => fileExists(join(root, gitFilePath('harness_decisions', 'live1'))));
  });
});
