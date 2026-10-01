/**
 * /api/activity/stream drain page — numeric keyset order across a digit-length boundary
 * (WI-10004608).
 *
 * The drain reads `id > cursor ... LIMIT n` and then moves the cursor to the largest id on
 * the page. The query selects `id::text AS id`, and an unqualified `ORDER BY id` binds to that
 * TEXT output alias, not the bigint column. Text order puts '10' and '1000' before '8', so a
 * page of two after cursor 7 came back as 10 and 1000, the cursor jumped to 1000, and rows
 * 8, 9, 998 and 999 were never pushed. Same defect class as WI-10004517 (the usage repricer
 * reported complete with 934,532 rows untouched) and the activity:recent freeze at id 999.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { queryActivitySince } from './stream';

const DDL = `
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE IF NOT EXISTS harness_shared.agent_activity (
    id BIGSERIAL PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT '*',
    owner_id text NOT NULL,
    agent text, session_id text, harness_slug text,
    kind text NOT NULL, tool_name text, phase text, tool_use_id text,
    summary text, status text, detail jsonb, cwd text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('activity-stream');
  await db.sql.unsafe(DDL);
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql.unsafe(`
    TRUNCATE harness_shared.agent_activity;
    INSERT INTO harness_shared.agent_activity (id, owner_id, harness_slug, kind, summary) VALUES
      (8,    'su-a', 'h1', 'tool', 'r8'),
      (9,    'su-a', 'h1', 'tool', 'r9'),
      (10,   'su-a', 'h1', 'tool', 'r10'),
      (998,  'su-a', 'h1', 'tool', 'r998'),
      (999,  'su-b', 'h1', 'tool', 'r999'),
      (1000, 'su-a', 'h2', 'tool', 'r1000'),
      (1500, 'su-a', 'h1', 'tool', 'r1500')
  `);
});

/** Drain exactly like the route does: page, advance the cursor to the page max, repeat. */
async function drainAll(opts: { cursor: number; owner?: string; harness?: string; limit: number }) {
  let cursor = opts.cursor;
  const seen: number[] = [];
  for (let page = 0; page < 20; page++) {
    const rows = await queryActivitySince(db.sql, {
      cursor,
      owner: opts.owner ?? null,
      harness: opts.harness ?? null,
      limit: opts.limit,
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      const id = Number(r.id);
      seen.push(id);
      if (id > cursor) cursor = id;
    }
  }
  return seen;
}

describe('activity stream drain page (WI-10004608)', () => {
  it('returns the numerically smallest ids after the cursor', async () => {
    const rows = await queryActivitySince(db.sql, { cursor: 7, owner: null, harness: null, limit: 2 });
    expect(rows.map((r) => r.id)).toEqual(['8', '9']);
  });

  it('a paged drain visits every row once, in numeric order, across 9->10 and 999->1000', async () => {
    expect(await drainAll({ cursor: 7, limit: 2 })).toEqual([8, 9, 10, 998, 999, 1000, 1500]);
  });

  it('keeps numeric order under the owner and harness filters', async () => {
    expect(await drainAll({ cursor: 0, owner: 'su-a', limit: 1 })).toEqual([8, 9, 10, 998, 1000, 1500]);
    expect(await drainAll({ cursor: 0, harness: 'h1', limit: 1 })).toEqual([8, 9, 10, 998, 999, 1500]);
  });
});
