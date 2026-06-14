/**
 * scan.integration.test.ts — the neologism miner's PG readers against a real
 * MIGRATED Postgres (the sibling of negative-space/scan.integration.test.ts).
 *
 * The unit suite (scan.test.ts) fakes the readers; this pins the SQL contract of
 * `readCoordTextRows` end-to-end — the kind allow-list, the category-null ambient
 * exclusion, the (workspace | '*' | 'default') scope union, the trailing window,
 * the summary+body text join + speaker default, and the empty-text drop — plus a
 * `readPrimitiveNames` smoke (the namespace a coined term must be ABSENT from).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config';
import { ALL_FLAG_KEYS } from '@papercusp/flags';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { readCoordTextRows, readPrimitiveNames } from './scan';

let db: OrgTestDb;
let seq = 0;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

/** Insert one coord_event_log row with a controllable scope/body/timestamp. */
async function seedEvent(workspaceId: string, body: Record<string, string>, ageDays = 0): Promise<void> {
  const ts = new Date(Date.now() - ageDays * 86_400_000);
  await db.adminSql`
    INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
    VALUES (${workspaceId}, 'coord', ${`m-${++seq}`}, ${db.adminSql.json(body)}, ${ts})`;
}

describe('readCoordTextRows — coined-vocabulary source filter', () => {
  const WS = 'ws-neo';

  beforeAll(async () => {
    // ✓ in-scope message (joins summary + body; speaker from body.from)
    await seedEvent(WS, { kind: 'message', from: 'alice', summary: 'the widget thrum', body: 'keeps flaking' });
    // ✓ cross-scope '*' handoff
    await seedEvent('*', { kind: 'handoff', from: 'bob', summary: 'pass the glorp' });
    // ✓ DEFAULT_COORD_WORKSPACE escalation
    await seedEvent('default', { kind: 'escalation', from: 'carol', body: 'the frobnicator stalled' });
    // ✓ no `from` → speaker defaults to 'unknown'
    await seedEvent(WS, { kind: 'message', summary: 'anonymous coinage: zorp' });
    // ✗ a different workspace (out of the scope union)
    await seedEvent('other-ws', { kind: 'message', from: 'mallory', summary: 'should NOT appear' });
    // ✗ a kind not in the allow-list
    await seedEvent(WS, { kind: 'notify', from: 'sys', summary: 'notify noise' });
    // ✗ an ambient machine broadcast (category set)
    await seedEvent(WS, { kind: 'message', category: 'service-health', summary: 'health ping' });
    // ✗ outside the trailing window
    await seedEvent(WS, { kind: 'message', from: 'old', summary: 'ancient widget talk' }, 60);
    // ✗ empty text (no summary, no body)
    await seedEvent(WS, { kind: 'message', from: 'empty' });
  });

  it('returns only allow-listed, category-null, in-scope, in-window rows with non-empty text', async () => {
    const rows = await readCoordTextRows(db.adminSql, WS, 14);
    const texts = rows.map((r) => r.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        'the widget thrum\nkeeps flaking', // summary + body joined
        'pass the glorp',
        'the frobnicator stalled',
        'anonymous coinage: zorp',
      ]),
    );
    // none of the excluded rows leak in
    const joined = texts.join(' | ');
    expect(joined).not.toMatch(/should NOT appear|notify noise|health ping|ancient widget talk/);
    // the empty-text row is dropped (no zero-length entries)
    expect(texts.every((t) => t.length > 0)).toBe(true);
  });

  it('defaults a missing speaker to "unknown" and maps body.from otherwise', async () => {
    const rows = await readCoordTextRows(db.adminSql, WS, 14);
    expect(rows.find((r) => r.text === 'anonymous coinage: zorp')?.speaker).toBe('unknown');
    expect(rows.find((r) => r.text.startsWith('the widget thrum'))?.speaker).toBe('alice');
  });

  it('honors the trailing window (a 1-day window drops the 60-day-old row but keeps fresh ones)', async () => {
    const rows = await readCoordTextRows(db.adminSql, WS, 1);
    expect(rows.some((r) => r.text === 'anonymous coinage: zorp')).toBe(true);
    expect(rows.some((r) => r.text === 'ancient widget talk')).toBe(false);
  });
});

describe('readPrimitiveNames — the primitive namespace a neologism must be absent from', () => {
  it('includes live DB table names and the in-process flag keys', async () => {
    const names = await readPrimitiveNames(db.adminSql);
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
    // information_schema leg: a known harness_shared table is a reserved name
    expect(names).toContain('coord_event_log');
    // flag-keys leg (in-process registry): every flag key is reserved
    expect(names).toContain(ALL_FLAG_KEYS[0]);
  });
});
