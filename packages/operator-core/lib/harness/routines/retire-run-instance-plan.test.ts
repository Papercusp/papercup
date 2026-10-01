/**
 * WI-10005040 — retiring a scheduled-run instance plan must close its plan_items.
 *
 * Two raw-SQL writers used to record only `status='superseded'`, leaving every
 * never-promoted `plan_items` row open forever (28 phantom-open items on 10
 * superseded instances, measured 2026-10-01). `retireRunInstancePlan` is now the one
 * path; this file pins its contract against the REAL content rewriters, with only the
 * Postgres seam doubled.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripCommentsOnly } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';

const H = vi.hoisted(() => ({ writeIndex: vi.fn() }));
vi.mock('../../agent-tools/plans/plan-index-rows', () => ({ writePlanIndexRows: H.writeIndex }));

import { retireRunInstancePlan, runInstanceRetiredNote } from './retire-run-instance-plan';

interface Recorded {
  text: string;
  values: unknown[];
}

/** A tagged-template `sql` double: SELECT returns `row` (or nothing), everything else is recorded. */
function fakeSql(row: Record<string, unknown> | null) {
  const calls: Recorded[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    return Promise.resolve(text.startsWith('SELECT') ? (row ? [row] : []) : []);
  }) as unknown as Sql;
  return { sql, calls };
}

const INPUT = {
  workspaceId: 'ws',
  planStorageSlug: 'papercusp',
  instanceSlug: 'tmpl@run-9',
  templateSlug: 'tmpl',
  outcome: 'success' as const,
};

const BODY = [
  '---',
  'status: active',
  '---',
  '# Instance',
  '',
  '- **P-001** `todo` open one',
  '- **P-002** `done` finished',
  '- **P-003** `wip` in flight',
  '- **P-004** `dropped` already dropped',
  '',
].join('\n');

const STORED_ITEMS = [
  { id: 'P-001', status: 'todo' },
  { id: 'P-002', status: 'done' },
  { id: 'P-003', status: 'wip' },
  { id: 'P-004', status: 'dropped' },
];

function updateOf(calls: Recorded[]): Recorded {
  const update = calls.find((c) => c.text.startsWith('UPDATE harness_shared.harness_plans'));
  if (!update) throw new Error('no harness_plans UPDATE recorded');
  return update;
}

function itemsWritten(update: Recorded): Array<{ id: string; status: string }> {
  const json = update.values.find((v) => typeof v === 'string' && v.startsWith('['));
  return JSON.parse(String(json));
}

beforeEach(() => {
  H.writeIndex.mockReset();
  H.writeIndex.mockResolvedValue(undefined);
});

describe('retireRunInstancePlan', () => {
  it('closes every non-terminal item as dropped, leaves terminal ones alone, and supersedes the plan', async () => {
    const { sql, calls } = fakeSql({ content: BODY, items: STORED_ITEMS, decisions: [] });

    const result = await retireRunInstancePlan(sql, INPUT);

    expect(result).toEqual({ retired: true, itemsClosed: 2 });
    const update = updateOf(calls);
    expect(update.text).toMatch(/SET status = 'superseded'/);
    // The status guard is the last predicate: a concurrent retire wins, never re-retire.
    expect(update.text).toMatch(/AND status = \?$/);
    expect(update.values.at(-1)).toBe('active');
    expect(itemsWritten(update)).toEqual([
      { id: 'P-001', status: 'dropped' },
      { id: 'P-002', status: 'done' },
      { id: 'P-003', status: 'dropped' },
      { id: 'P-004', status: 'dropped' },
    ]);
  });

  it('rewrites the content too, so the derived plan_items index cannot diverge from it', async () => {
    const { sql, calls } = fakeSql({ content: BODY, items: STORED_ITEMS, decisions: [] });
    await retireRunInstancePlan(sql, INPUT);

    const body = String(updateOf(calls).values.find((v) => typeof v === 'string' && v.startsWith('---')));
    expect(body).toMatch(/^status: superseded$/m);
    expect(body).toMatch(/\*\*P-001\*\* `dropped`.*run settled success/);
    expect(body).toMatch(/\*\*P-003\*\* `dropped`/);
    // Terminal items are untouched, including the already-done one (never relabelled).
    expect(body).toMatch(/\*\*P-002\*\* `done` finished$/m);
  });

  it('writes the plan_items index from the CLOSED items on the same sql seam', async () => {
    const { sql } = fakeSql({ content: BODY, items: STORED_ITEMS, decisions: [{ id: 'D-001' }] });
    await retireRunInstancePlan(sql, INPUT);

    expect(H.writeIndex).toHaveBeenCalledTimes(1);
    const [seam, key, payload] = H.writeIndex.mock.calls[0]!;
    expect(seam).toBe(sql);
    expect(key).toEqual({ workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: 'tmpl@run-9' });
    expect(payload.items.map((i: { status: string }) => i.status)).toEqual(['dropped', 'done', 'dropped', 'dropped']);
    expect(payload.decisions).toEqual([{ id: 'D-001' }]);
  });

  it('derives items from the content when no index is stored (a seed that wrote content only)', async () => {
    const { sql, calls } = fakeSql({ content: BODY, items: [], decisions: [] });
    const result = await retireRunInstancePlan(sql, INPUT);

    expect(result.itemsClosed).toBe(2);
    expect(itemsWritten(updateOf(calls)).filter((i) => i.status === 'dropped').length).toBe(3);
  });

  it("backfill form: onlyIfStatus 'superseded' re-runs an already-superseded instance through the same path", async () => {
    const { sql, calls } = fakeSql({ content: BODY.replace('status: active', 'status: superseded'), items: STORED_ITEMS, decisions: [] });

    const result = await retireRunInstancePlan(sql, { ...INPUT, onlyIfStatus: 'superseded' });

    expect(result).toEqual({ retired: true, itemsClosed: 2 });
    const select = calls.find((c) => c.text.startsWith('SELECT'))!;
    expect(select.values.at(-1)).toBe('superseded');
    expect(updateOf(calls).values.at(-1)).toBe('superseded');
    // The plan stays superseded; only its items move.
    expect(itemsWritten(updateOf(calls)).map((i) => i.status)).toEqual(['dropped', 'done', 'dropped', 'dropped']);
  });

  it('is an idempotent no-op when the instance is absent or already retired', async () => {
    const { sql, calls } = fakeSql(null);

    await expect(retireRunInstancePlan(sql, INPUT)).resolves.toEqual({ retired: false, itemsClosed: 0 });
    expect(calls.some((c) => c.text.startsWith('UPDATE'))).toBe(false);
    expect(H.writeIndex).not.toHaveBeenCalled();
  });

  it('records WHY on the item: the settled outcome and that no work-item completed it', async () => {
    const { sql, calls } = fakeSql({ content: BODY, items: STORED_ITEMS, decisions: [] });
    await retireRunInstancePlan(sql, { ...INPUT, outcome: 'failed' });

    const body = String(updateOf(calls).values.find((v) => typeof v === 'string' && v.startsWith('---')));
    expect(body).toContain(runInstanceRetiredNote('failed').replace(/[()]/g, ''));
    expect(runInstanceRetiredNote('failed')).toMatch(/never completed by a work-item/);
  });
});

/**
 * Recurrence guard (WI-10005040): the CLASS of bug is "a writer retires a run instance
 * with a bare `UPDATE harness_plans SET status='superseded'`". The SQL lives INSIDE a
 * template literal, so strings are kept and only COMMENTS are stripped (a comment that
 * explains the old bug must not trip the scan).
 */
describe('both instance-retiring writers go through retireRunInstancePlan', () => {
  const BARE_FLIP = /UPDATE\s+harness_shared\.harness_plans\s+SET\s+status\s*=\s*'superseded'\s+WHERE/;
  const WRITERS = ['reconcile-plan-runs.ts', 'plan-run-action.ts'];
  const live = (file: string) => stripCommentsOnly(readFileSync(join(__dirname, file), 'utf8'), file);

  it('calibration: the detector DOES match the bare flip these writers used to contain', () => {
    const old = `await db\`
      UPDATE harness_shared.harness_plans
         SET status = 'superseded'
       WHERE workspace_id = \${w}\``;
    expect(BARE_FLIP.test(old)).toBe(true);
    // ...and a comment quoting it is invisible to the scan.
    const quoted = `// UPDATE harness_shared.harness_plans SET status = 'superseded' WHERE x\n`;
    expect(BARE_FLIP.test(stripCommentsOnly(quoted, 'x.ts'))).toBe(false);
  });

  it.each(WRITERS)('%s has no bare status flip and calls retireRunInstancePlan', (file) => {
    const src = live(file);
    expect(src).not.toMatch(BARE_FLIP);
    expect(src).toMatch(/\bretireRunInstancePlan\(/);
  });

  it('the helper itself rewrites items AND the plan_items index, never the status alone', () => {
    const src = live('retire-run-instance-plan.ts');
    expect(src).toMatch(/items\s*=\s*\$\{JSON\.stringify\(closedItems\)\}/);
    expect(src).toMatch(/\bwritePlanIndexRows\(/);
  });
});
