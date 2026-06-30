import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { enrichPlanListRows, enrichPlanDetail } from './plan-attribution';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/**
 * A fake postgres-js `sql` whose `.unsafe(query, params)` dispatches on the
 * query text, so the enrichment logic is tested without a real DB.
 */
function fakeSql(tables: {
  revisions?: Array<{ harness_slug: string; plan_slug: string; author_id: string; author_kind: string }>;
  members?: Array<{ github_user_id: number; github_username: string; display_name: string | null; avatar_url: string | null; device_attestations: unknown }>;
  parts?: Array<{ part_key: string; author: string | null }>;
  users?: Array<{ id: string; username: string; display_name: string | null }>;
}): Sql {
  const unsafe = async (query: string) => {
    if (query.includes('plan_revisions')) return tables.revisions ?? [];
    if (query.includes('hive_members')) return tables.members ?? [];
    if (query.includes('harness_plan_parts')) return tables.parts ?? [];
    if (query.includes('harness_shared.users')) return tables.users ?? [];
    return [];
  };
  return { unsafe } as unknown as Sql;
}

describe('enrichPlanListRows', () => {
  it('attaches ownerIdentity + lastEditor; null when absent', async () => {
    const sql = fakeSql({
      revisions: [{ harness_slug: 'papercup', plan_slug: 'a', author_id: 'su-88991fc5-dd92', author_kind: 'agent' }],
    });
    const rows = (await enrichPlanListRows(
      [
        { slug: 'a', owner: 'aviynw2@gmail.com', harness: 'papercup' },
        { slug: 'b', owner: null, harness: 'papercup' },
      ],
      { sql, workspaceId: 'default' },
    )) as Array<Record<string, unknown>>;

    expect(rows[0].ownerIdentity).toMatchObject({ handle: 'aviynw2', kind: 'human', verified: false });
    expect((rows[0].ownerIdentity as { handle: string }).handle).not.toContain('@');
    expect(rows[0].lastEditor).toMatchObject({ handle: 'su-88991fc5', kind: 'agent' });
    // row b — no owner, no revision
    expect(rows[1].ownerIdentity).toBeNull();
    expect(rows[1].lastEditor).toBeNull();
  });

  it('enriches the owner to a verified github member when hive_members has a match', async () => {
    const sql = fakeSql({
      members: [
        { github_user_id: 42, github_username: 'aviynw2', display_name: 'Avi', avatar_url: 'https://a/42.png', device_attestations: [] },
      ],
    });
    const rows = (await enrichPlanListRows([{ slug: 'a', owner: 'aviynw2@gmail.com', harness: 'papercup' }], {
      sql,
      workspaceId: 'default',
    })) as Array<Record<string, unknown>>;
    expect(rows[0].ownerIdentity).toMatchObject({
      id: '42',
      handle: 'aviynw2',
      avatarUrl: 'https://a/42.png',
      verified: true,
    });
  });

  it('returns the input untouched for an empty list', async () => {
    const sql = fakeSql({});
    expect(await enrichPlanListRows([], { sql })).toEqual([]);
  });
});

describe('enrichPlanDetail', () => {
  it('attaches plan-level identity + per-item author, dropping sentinel authors', async () => {
    const sql = fakeSql({
      revisions: [{ harness_slug: 'papercup', plan_slug: 'a', author_id: 'su-88991fc5-dd92', author_kind: 'agent' }],
      parts: [
        { part_key: 'item:P-001', author: 'pk-real-device' }, // unbound here → short pubkey (agent), dark
        { part_key: 'item:P-002', author: 'local' }, // sentinel — dropped by the reader
      ],
    });
    const plan = {
      frontmatter: { slug: 'a', owner: 'aviynw2@gmail.com' },
      items: [{ id: 'P-001' }, { id: 'P-002' }, { id: 'P-003' }],
    };
    const out = (await enrichPlanDetail(plan, { sql, workspaceId: 'default', harnessSlug: 'papercup' })) as {
      ownerIdentity: unknown;
      lastEditor: unknown;
      items: Array<{ id: string; lastEditedBy: unknown }>;
    };

    expect(out.ownerIdentity).toMatchObject({ handle: 'aviynw2', kind: 'human' });
    expect(out.lastEditor).toMatchObject({ handle: 'su-88991fc5', kind: 'agent' });
    // P-001 has a real (if unbound) pubkey → resolves to a short-pubkey agent chip
    expect(out.items[0].lastEditedBy).toMatchObject({ kind: 'agent', verified: false });
    // P-002's author is the 'local' sentinel → dropped (no badge)
    expect(out.items[1].lastEditedBy).toBeNull();
    // P-003 has no part author at all
    expect(out.items[2].lastEditedBy).toBeNull();
  });

  it('returns the plan untouched when it has no frontmatter', async () => {
    const sql = fakeSql({});
    const plan = { items: [] };
    expect(await enrichPlanDetail(plan, { sql })).toBe(plan);
  });

  it('derives the attribution harness from the plan payload, not the operator home (WI-374)', async () => {
    const member = 'member-harness-x';
    const sql = fakeSql({
      revisions: [{ harness_slug: member, plan_slug: 'a', author_id: 'su-88991fc5-dd92', author_kind: 'agent' }],
    });
    // The plan carries its OWN harness stamp; NO opts.harnessSlug is passed. The revision is
    // keyed under the member harness — it only resolves if enrichPlanDetail keys on the plan's
    // real harness rather than a silent operator-home fallback.
    const plan = { harness: member, frontmatter: { slug: 'a', owner: 'aviynw2@gmail.com' }, items: [] };
    const out = (await enrichPlanDetail(plan, { sql, workspaceId: 'default' })) as {
      ownerIdentity: unknown;
      lastEditor: unknown;
    };
    expect(out.lastEditor).toMatchObject({ handle: 'su-88991fc5', kind: 'agent' });
    expect(out.ownerIdentity).toMatchObject({ handle: 'aviynw2', kind: 'human' });
  });

  it('does NOT silently attribute to the operator-home harness when no harness is given (WI-374)', async () => {
    const home = operatorHomeHarnessSlug();
    const sql = fakeSql({
      // A revision EXISTS under the HOME harness: the OLD silent `?? operatorHomeHarnessSlug()`
      // would have keyed on it and mis-attributed a lastEditor. The fixed code has no harness to
      // key on (neither opts.harnessSlug nor the plan's own `harness`), so it must NOT enrich —
      // never a home-harness guess.
      revisions: [{ harness_slug: home, plan_slug: 'a', author_id: 'su-88991fc5-dd92', author_kind: 'agent' }],
    });
    const plan = { frontmatter: { slug: 'a', owner: 'aviynw2@gmail.com' }, items: [] };
    expect(await enrichPlanDetail(plan, { sql })).toBe(plan);
  });
});
