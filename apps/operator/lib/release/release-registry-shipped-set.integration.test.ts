/**
 * snapshotWindow regression — the 0.0.14 "1138 items / 1 plan" under-report (2026-08-10,
 * EI-20071526453281952).
 *
 * Two compounding defects made the release record describe a fraction of what shipped:
 *
 *  1. TERMINAL_STATUSES was ['resolved','passed','closed'] — it OMITTED 'done', which is what
 *     `work_items:complete { state:'done' }` writes, i.e. the canonical completion verb the whole
 *     fleet uses. Measured over the real 0.0.14 window: 2,796 completed user-facing items were
 *     dropped while 1,138 were counted.
 *
 *  2. Plans were reverse-derived SOLELY from work_items.source_plan_slug, which is populated on
 *     ~10% of items and on ~0% of the then-terminal statuses (resolved 0/1085, closed 0/52). The
 *     reported "1 plan" was a single 'passed' row. 26 plans had actually shipped in that window.
 *
 * THE FIXTURE BELOW IS THE 0.0.14 SHAPE: items completed as 'done' carrying NO source_plan_slug,
 * plus a plan that reached 'shipped' in the window. Against the pre-fix code it yields zero items
 * and zero plans, so this test fails without the fix rather than merely describing it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { getTestPg } from '@papercusp/test-config/pg';
import { snapshotWindow, TERMINAL_STATUSES } from './release-registry';

let sql: postgres.Sql;
const WS = `shipped-set-${Math.random().toString(36).slice(2, 10)}`;
const HARNESS = 'papercusp';
const FROM = Date.parse('2026-07-29T00:00:00Z');
const TO = Date.parse('2026-08-10T00:00:00Z');
const MID = FROM + (TO - FROM) / 2;
const scope = { workspaceId: WS, harnessSlug: HARNESS };

beforeAll(async () => {
  const dbUrl = await getTestPg();
  sql = postgres(dbUrl, { max: 1 });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.work_items (
      workspace_id     text   NOT NULL,
      harness_slug     text   NOT NULL,
      feature_id       text   NOT NULL,
      title            text,
      summary          text,
      source_plan_slug text,
      status           text,
      updated_ts       bigint,
      admission text, admitted_at timestamptz, admitted_by text,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    )
  `);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_plans (
      workspace_id text        NOT NULL,
      harness_slug text        NOT NULL,
      plan_slug    text        NOT NULL,
      title        text,
      status       text,
      content      text        NOT NULL DEFAULT '',
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    )
  `);

  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, source_plan_slug, status, updated_ts)
    VALUES
      -- The 0.0.14 shape: completed via work_items:complete, no plan back-link.
      (${WS}, ${HARNESS}, 'WI-9001', 'done, unlinked',      '', NULL,          'done',     ${MID}),
      (${WS}, ${HARNESS}, 'WI-9002', 'done, unlinked too',  '', NULL,          'done',     ${MID}),
      -- One item DOES carry the back-link, so the union has something to dedupe against.
      (${WS}, ${HARNESS}, 'WI-9003', 'done, linked',        '', 'plan-linked', 'done',     ${MID}),
      -- Internal (EI-) items count separately, never as user-facing.
      (${WS}, ${HARNESS}, 'EI-9004', 'internal',            '', NULL,          'done',     ${MID}),
      -- CONTROLS: abandoned and still-open work must NOT be reported as shipped.
      (${WS}, ${HARNESS}, 'WI-9005', 'dropped, not shipped',   '', NULL,       'dropped',  ${MID}),
      (${WS}, ${HARNESS}, 'WI-9006', 'still open',             '', NULL,       'open',     ${MID}),
      -- CONTROL: terminal but OUTSIDE the window.
      (${WS}, ${HARNESS}, 'WI-9007', 'done before window',     '', NULL,       'done',     ${FROM - 1})
  `;
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, updated_at)
    VALUES
      (${WS}, ${HARNESS}, 'plan-shipped', 'A plan that shipped', 'shipped', '',
        to_timestamp(${MID}::bigint / 1000.0)),
      (${WS}, ${HARNESS}, 'plan-linked',  'Reached via an item', 'active',  '',
        to_timestamp(${MID}::bigint / 1000.0)),
      -- CONTROLS: shipped but OUTSIDE the window, and in-window but not shipped.
      (${WS}, ${HARNESS}, 'plan-old',     'Shipped long ago',    'shipped', '',
        to_timestamp(${(FROM - 60_000)}::bigint / 1000.0)),
      (${WS}, ${HARNESS}, 'plan-active',  'Still in flight',     'active',  '',
        to_timestamp(${MID}::bigint / 1000.0))
  `;
}, 120_000);

afterAll(async () => {
  if (sql) {
    await sql`DELETE FROM harness_shared.work_items   WHERE workspace_id = ${WS}`.catch(() => {});
    await sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS}`.catch(() => {});
    await sql.end();
  }
});

describe("snapshotWindow — 'done' is terminal, and plans come from the plans table", () => {
  it("counts 'done' items — the state work_items:complete actually writes", async () => {
    const snap = await snapshotWindow(sql, scope, FROM, TO);
    const ids = snap.items.map((i) => i.id).sort();
    // WI-9001/2/3 are done + in-window + user-facing. Pre-fix this array was EMPTY.
    expect(ids).toEqual(['WI-9001', 'WI-9002', 'WI-9003']);
    expect(snap.internalIds).toEqual(['EI-9004']);
  });

  it('excludes abandoned, open, and out-of-window work', async () => {
    const snap = await snapshotWindow(sql, scope, FROM, TO);
    const ids = snap.items.map((i) => i.id);
    expect(ids).not.toContain('WI-9005'); // dropped ≠ shipped
    expect(ids).not.toContain('WI-9006'); // open
    expect(ids).not.toContain('WI-9007'); // before the window
  });

  it('reports a shipped plan even when NO item back-links to it', async () => {
    const snap = await snapshotWindow(sql, scope, FROM, TO);
    const slugs = snap.plans.map((p) => p.slug).sort();
    // 'plan-shipped' is reachable ONLY via harness_plans — no item carries its slug.
    // This is the exact 0.0.14 collapse, and the assertion the old code cannot satisfy.
    expect(slugs).toContain('plan-shipped');
    // The item-derived leg still contributes, so the union holds both.
    expect(slugs).toEqual(['plan-linked', 'plan-shipped']);
  });

  it('does not sweep in plans that are merely active, or shipped outside the window', async () => {
    const snap = await snapshotWindow(sql, scope, FROM, TO);
    const slugs = snap.plans.map((p) => p.slug);
    expect(slugs).not.toContain('plan-old'); // shipped, but before the window
    expect(slugs).not.toContain('plan-active'); // in-window, but never shipped
  });

  it("pins 'done' in TERMINAL_STATUSES so a future edit cannot silently drop it again", () => {
    expect([...TERMINAL_STATUSES]).toContain('done');
    // 'dropped'/'deprecated' are abandoned work — they must never count as shipped.
    expect([...TERMINAL_STATUSES]).not.toContain('dropped');
    expect([...TERMINAL_STATUSES]).not.toContain('deprecated');
  });
});
