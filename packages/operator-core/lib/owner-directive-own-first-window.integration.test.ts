/**
 * owner-directive-own-first-window.integration.test.ts — real-PG guard for WI-10002888.
 *
 * THE DEFECT. Every banner render point (turn-start Orientation, the carry document,
 * the loop-fire wake) reads the open directives through `listOpenOwnerDirectives`
 * with a small LIMIT. That read was ordered purely oldest-first across the WORKSPACE,
 * so once 12+ older directives from other sessions were open, the viewing session's
 * own newer directive fell outside the fetched window. The render-time
 * "your own first" ordering never saw the row, so the banner showed only other
 * sessions' [FYI] rows plus "+N more". It hid the one row that asked this session to
 * act. This was measured live on 2026-09-24 (directive #470, session su-9b823ba3).
 *
 * WHY REAL PG. The bug lives in the SQL ORDER BY/LIMIT, so a fixture render test
 * cannot see it. That blind spot is why the render-level own-first tests stayed green
 * while production dropped the row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { listOpenOwnerDirectives, listOwnerDirectives, recordOwnerDirective } from './owner-directives';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('open-directive render window puts the viewer’s own rows first (WI-10002888)', () => {
  let db: OrgTestDb;
  const workspaceId = 'owner-directive-own-first-window-ws';
  const viewer = 'su-viewer-session';
  const window = 12;
  const peerIds: number[] = [];
  let ownId = 0;

  async function record(recordedBy: string, n: number): Promise<number> {
    const row = await recordOwnerDirective(
      {
        workspaceId,
        sessionRef: `session-${recordedBy}`,
        sourceTurnRef: `turn-${recordedBy}-${n}`,
        verbatimText: `directive ${n} typed to ${recordedBy}`,
        recordedBy,
        capturedByHook: true,
      },
      db.adminSql,
    );
    return row.id;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    // More OLDER peer directives than the render window holds, then the viewer's own,
    // NEWEST — the exact shape measured live.
    for (let i = 0; i < window + 1; i += 1) peerIds.push(await record(`su-peer-${i % 3}`, i));
    ownId = await record(viewer, 99);
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  it('calibration: the fixture really overflows the window when read oldest-first', async () => {
    const ledger = await listOwnerDirectives({ workspaceId, open: true, limit: window }, db.adminSql);
    expect(ledger).toHaveLength(window);
    // Without a viewer (the orders:list ledger view) the order stays oldest-first,
    // so the newest own row is outside the window. This is the condition that hid it.
    expect(ledger.map((r) => r.id)).not.toContain(ownId);
    expect(ledger.map((r) => r.id)).toEqual(peerIds.slice(0, window));
  });

  it('the viewer’s own directive is fetched, and fetched first, despite 13 older peer rows', async () => {
    const rows = await listOpenOwnerDirectives(workspaceId, window, db.adminSql, viewer);
    expect(rows).toHaveLength(window);
    expect(rows[0]?.id).toBe(ownId);
    expect(rows[0]?.recordedBy).toBe(viewer);
    // Peers keep their oldest-first order behind the viewer's rows.
    expect(rows.slice(1).map((r) => r.id)).toEqual(peerIds.slice(0, window - 1));
  });

  it('a viewer with no directives of its own still sees the oldest-first workspace window', async () => {
    const rows = await listOpenOwnerDirectives(workspaceId, window, db.adminSql, 'su-uninvolved');
    expect(rows.map((r) => r.id)).toEqual(peerIds.slice(0, window));
  });
});
