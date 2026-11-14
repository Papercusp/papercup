import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import { enrichPlanListRows, enrichPlanItemsRows, enrichPlanDetail } from './plan-attribution';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/**
 * A fake postgres-js `sql` whose `.unsafe(query, params)` dispatches on the
 * query text, so the enrichment logic is tested without a real DB.
 */
function fakeSql(tables: {
  revisions?: Array<{ harness_slug: string; plan_slug: string; author_id: string; author_kind: string }>;
  members?: Array<{ github_user_id: number; github_username: string; display_name: string | null; avatar_url: string | null; device_attestations: unknown }>;
  parts?: Array<{ plan_slug?: string; part_key: string; author: string | null }>;
  users?: Array<{ id: string; username: string; display_name: string | null }>;
}): Sql {
  const unsafe = async (query: string) => {
    if (query.includes('plan_revisions')) return tables.revisions ?? [];
    if (query.includes('pot_members')) return tables.members ?? [];
    if (query.includes('harness_plan_parts')) return tables.parts ?? [];
    if (query.includes('harness_shared.users')) return tables.users ?? [];
    return [];
  };
  return { unsafe } as unknown as Sql;
}

describe('enrichPlanListRows', () => {
  it('attaches ownerIdentity + lastEditor; ABSENT (not null) when unresolved', async () => {
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
    // WI-7045: unresolved attribution is ABSENT, not null — the enrichment runs
    // after projectPlansReadForUi's null-key omission, so writing an explicit null
    // here would put the keys back and contradict PlanListRow's `?: AuthorIdentity`.
    expect(rows[1].ownerIdentity).toBeUndefined();
    expect(rows[1].lastEditor).toBeUndefined();
    expect('ownerIdentity' in (rows[1] as object)).toBe(false);
    expect('lastEditor' in (rows[1] as object)).toBe(false);
  });

  it('enriches the owner to a verified github member when pot_members has a match', async () => {
    const sql = fakeSql({
      members: [
        { github_user_id: 42, github_username: 'aviynw2', display_name: 'Dev', avatar_url: 'https://a/42.png', device_attestations: [] },
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

  /**
   * EI-19455103442009801 — a null `avatarUrl` is OMITTED, not shipped. It was null
   * on 1,475/1,475 live occurrences of the plans.list superset read (25,075 B,
   * ~3.5%), and the key's absence carries the same information.
   *
   * ⚠ This MUST be guarded here rather than in ui-read-projection.test.ts: that
   * projection runs BEFORE this enrichment, which deletes and re-attaches both
   * identity keys, so the same assertion there passes while production still ships
   * the nulls. That near-miss is the whole reason this test exists.
   */
  it('OMITS a null avatarUrl from the attached identities (not `avatarUrl: null`)', async () => {
    const sql = fakeSql({
      // An authorId with no pot_members match → resolves with avatarUrl null.
      revisions: [{ harness_slug: 'papercup', plan_slug: 'a', author_id: 'su-88991fc5-dd92', author_kind: 'agent' }],
    });
    const rows = (await enrichPlanListRows(
      [{ slug: 'a', owner: 'aviynw2@gmail.com', harness: 'papercup' }],
      { sql, workspaceId: 'default' },
    )) as Array<Record<string, unknown>>;

    const lastEditor = rows[0].lastEditor as Record<string, unknown>;
    const ownerIdentity = rows[0].ownerIdentity as Record<string, unknown>;
    expect('avatarUrl' in lastEditor).toBe(false);
    expect('avatarUrl' in ownerIdentity).toBe(false);
    // The rest of the identity is untouched — this omits one key, it does not slim.
    expect(lastEditor).toMatchObject({ handle: 'su-88991fc5', kind: 'agent', verified: false });
    expect(lastEditor.id).toBeDefined();
  });

  /**
   * The shared-object hazard: `resolvePlanAuthorIdentities` returns a Map whose
   * values are reused across every row referencing the same author, so stripping
   * by mutation would corrupt sibling rows. Two rows with the SAME last editor
   * must both come back stripped AND intact.
   */
  it('does not corrupt identities shared across rows (copy-on-null, no mutation)', async () => {
    const sql = fakeSql({
      revisions: [
        { harness_slug: 'papercup', plan_slug: 'a', author_id: 'su-88991fc5-dd92', author_kind: 'agent' },
        { harness_slug: 'papercup', plan_slug: 'b', author_id: 'su-88991fc5-dd92', author_kind: 'agent' },
      ],
    });
    const rows = (await enrichPlanListRows(
      [
        { slug: 'a', owner: null, harness: 'papercup' },
        { slug: 'b', owner: null, harness: 'papercup' },
      ],
      { sql, workspaceId: 'default' },
    )) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const le = row.lastEditor as Record<string, unknown>;
      expect(le).toBeDefined();
      expect('avatarUrl' in le).toBe(false);
      expect(le).toMatchObject({ handle: 'su-88991fc5', kind: 'agent' });
    }
  });

  it('returns the input untouched for an empty list', async () => {
    const sql = fakeSql({});
    expect(await enrichPlanListRows([], { sql })).toEqual([]);
  });

  it('requests only distinct, fully scoped plan pairs for revision attribution', async () => {
    const unsafe = vi.fn().mockResolvedValue([]);
    await enrichPlanListRows([
      { slug: 'same', harness: 'first' },
      { slug: 'same', harness: 'second' },
      { slug: 'same', harness: 'first' },
      { slug: 'missing-harness' },
      { harness: 'first' },
    ], { sql: { unsafe } as unknown as Sql, workspaceId: 'workspace-a' });

    expect(unsafe).toHaveBeenCalledTimes(1);
    expect(unsafe.mock.calls[0][1]).toEqual([
      'workspace-a', ['first', 'second'], ['same', 'same'],
    ]);
  });
});

describe('enrichPlanItemsRows', () => {
  it('attaches item.lastEditedBy; ABSENT (not null) when unresolved (WI-7086)', async () => {
    const sql = fakeSql({
      parts: [
        { plan_slug: 'a', part_key: 'item:P-001', author: 'pk-real-device' },
        { plan_slug: 'a', part_key: 'item:P-002', author: 'local' }, // sentinel — dropped
      ],
    });
    const rows = (await enrichPlanItemsRows(
      [
        { plan: 'a', item: { id: 'P-001' } },
        { plan: 'a', item: { id: 'P-002' } }, // sentinel author
        { plan: 'a', item: { id: 'P-003' } }, // no part row at all
      ],
      { sql, workspaceId: 'default' },
    )) as Array<{ item: Record<string, unknown> }>;

    expect(rows[0].item.lastEditedBy).toMatchObject({ kind: 'agent', verified: false });
    // ⚠ THE POINT OF THIS TEST. This enrichment runs AFTER the UI projection's
    // null-omission, so an unconditional `lastEditedBy: null` lands behind it and
    // silently re-inflates the payload — 2,542 of 3,327 rows on the live read.
    // `toBeNull()` here would pass just as happily on the broken version; only
    // asserting KEY ABSENCE distinguishes them.
    expect('lastEditedBy' in rows[1].item).toBe(false);
    expect('lastEditedBy' in rows[2].item).toBe(false);
  });

  it('strips an inbound lastEditedBy:null rather than passing it through', async () => {
    const sql = fakeSql({
      parts: [{ plan_slug: 'a', part_key: 'item:P-001', author: 'pk-real-device' }],
    });
    const rows = (await enrichPlanItemsRows(
      [
        { plan: 'a', item: { id: 'P-001', lastEditedBy: null } },
        { plan: 'a', item: { id: 'P-009', lastEditedBy: null } },
      ],
      { sql, workspaceId: 'default' },
    )) as Array<{ item: Record<string, unknown> }>;

    expect(rows[0].item.lastEditedBy).toMatchObject({ kind: 'agent' });
    expect('lastEditedBy' in rows[1].item).toBe(false);
  });

  it('returns rows untouched when no author resolves at all', async () => {
    const sql = fakeSql({});
    const input = [{ plan: 'a', item: { id: 'P-001' } }];
    const rows = (await enrichPlanItemsRows(input, { sql, workspaceId: 'default' })) as Array<{
      item: Record<string, unknown>;
    }>;
    expect('lastEditedBy' in rows[0].item).toBe(false);
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

  // WI-7259 (sibling of WI-374's harness fix above): a scheduled-run snapshot's
  // markdown is a byte-identical copy of its parent's, frontmatter included, so
  // `plan.frontmatter.slug` reads the PARENT's slug. plans:get stamps the
  // REQUESTED slug at the top level (`slug` = row.planSlug) — prefer it.
  it('prefers the payload-level `slug` (row.planSlug) over frontmatter.slug for a snapshot (WI-7259)', async () => {
    const sql = fakeSql({
      // The revision/part-author history is keyed under the SNAPSHOT's own
      // slug, never its parent's — attributing from the wrong slug would
      // silently resolve to nothing (or worse, a same-slug foreign plan).
      revisions: [{ harness_slug: 'papercup', plan_slug: 'parent@run-123', author_id: 'su-88991fc5-dd92', author_kind: 'agent' }],
    });
    const plan = {
      harness: 'papercup',
      slug: 'parent@run-123',
      // The parent's frontmatter, copied verbatim — a DIFFERENT slug.
      frontmatter: { slug: 'parent', owner: 'aviynw2@gmail.com' },
      items: [],
    };
    const out = (await enrichPlanDetail(plan, { sql, workspaceId: 'default' })) as { lastEditor: unknown };
    expect(out.lastEditor).toMatchObject({ handle: 'su-88991fc5', kind: 'agent' });
  });

  it('falls back to frontmatter.slug when the payload carries no top-level `slug` (older caller/fixture)', async () => {
    const sql = fakeSql({
      revisions: [{ harness_slug: 'papercup', plan_slug: 'a', author_id: 'su-88991fc5-dd92', author_kind: 'agent' }],
    });
    const plan = { harness: 'papercup', frontmatter: { slug: 'a', owner: 'aviynw2@gmail.com' }, items: [] };
    const out = (await enrichPlanDetail(plan, { sql, workspaceId: 'default' })) as { lastEditor: unknown };
    expect(out.lastEditor).toMatchObject({ handle: 'su-88991fc5', kind: 'agent' });
  });
});

// ── WI-39823: the read deadline ────────────────────────────────────────────
//
// This file's header states the contract: "additive + best-effort: any failure
// leaves the base payload untouched (the UI simply renders no badge)". The
// `try`/`catch` around the author fan-out delivered that for a leg that THROWS.
// A leg that HANGS was never covered — `Promise.all` waits for the slowest, so
// one wedged author read held the whole plan-detail sync query past the resolver
// timeout. That is not "no badge", that is no PLAN: a decoration taking the
// payload down is precisely the inversion the best-effort contract forbids.
//
// Controls are PERMANENT and tier-1 (CLAUDE.md): the deliberately-wrong version
// is the real function with `budgetMs` widened past firing — a production
// parameter, so the control exercises a live branch instead of a copy that rots.
describe('enrichPlanDetail — read deadline (WI-39823)', () => {
  /** Never settles — a wedged store, not a failing one. */
  const hangingSql = (): Sql => ({ unsafe: () => new Promise(() => {}) }) as unknown as Sql;

  type Settled = { kind: 'resolved'; value: unknown } | { kind: 'rejected'; message: string } | { kind: 'pending' };

  /** "Never settled" has to be an assertable OUTCOME, not a vitest timeout. */
  const settleWithin = (p: Promise<unknown>, ms: number): Promise<Settled> =>
    Promise.race([
      p.then(
        (value): Settled => ({ kind: 'resolved', value }),
        (error): Settled => ({ kind: 'rejected', message: String((error as Error)?.message ?? error) }),
      ),
      new Promise<Settled>((resolve) => {
        const t = setTimeout(() => resolve({ kind: 'pending' }), ms);
        (t as unknown as { unref?: () => void }).unref?.();
      }),
    ]);

  const plan = () => ({
    harness: 'papercup',
    frontmatter: { slug: 'a', owner: 'aviynw2@gmail.com' },
    items: [{ id: 'P-001' }],
  });

  it('a hung author read degrades to NO BADGE and still returns the plan', async () => {
    const outcome = await settleWithin(
      enrichPlanDetail(plan(), { sql: hangingSql(), workspaceId: 'default', harnessSlug: 'papercup', budgetMs: 25 }),
      500,
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    const out = outcome.value as { frontmatter: { slug: string }; lastEditor?: unknown; items: unknown[] };
    // The PLAN survives — that is the contract. The badge does not, which is the
    // documented, acceptable degradation.
    expect(out.frontmatter.slug).toBe('a');
    expect(out.items).toHaveLength(1);
    // `null`, not absent: unlike the LIST enricher (WI-7045, where an unresolved
    // badge is omitted), the detail payload writes an explicit null here. Pinned
    // as observed rather than as assumed — the claim under test is that the plan
    // survives, and asserting the wrong neighbour would make this guard fail for
    // a reason that has nothing to do with the deadline.
    expect(out.lastEditor).toBeNull();
  });

  it('CONTROL: the same hung read NEVER settles when the bound is widened — so it is the deadline doing the work', async () => {
    const outcome = await settleWithin(
      enrichPlanDetail(plan(), {
        sql: hangingSql(),
        workspaceId: 'default',
        harnessSlug: 'papercup',
        budgetMs: 10_000_000,
      }),
      120,
    );

    expect(outcome.kind).toBe('pending');
  });

  it('CALIBRATION: a healthy read still attaches its badges under the same tight budget', async () => {
    // Guards the opposite failure: a bound that "passes" the test above by
    // stripping every badge, healthy store or not.
    const sql = fakeSql({
      revisions: [{ harness_slug: 'papercup', plan_slug: 'a', author_id: 'su-88991fc5-dd92', author_kind: 'agent' }],
    });

    const out = (await enrichPlanDetail(plan(), {
      sql,
      workspaceId: 'default',
      harnessSlug: 'papercup',
      budgetMs: 25,
    })) as { lastEditor: unknown };

    expect(out.lastEditor).toMatchObject({ handle: 'su-88991fc5', kind: 'agent' });
  });
});
