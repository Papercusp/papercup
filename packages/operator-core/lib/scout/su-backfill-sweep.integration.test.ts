/**
 * su-backfill-sweep.integration.test.ts — su-ideate-learning-substrate-2026-07-10
 * P-016 against real migrated Postgres. Pins:
 *  - the pre-bridge identification SIGNATURE (source='su' + payload
 *    improvementKind='feature' + created_at < cutoff + not-in-ledger): a post-bridge
 *    filing, a non-feature su filing, an engineer-sourced item, and an
 *    already-ledgered filing are all EXCLUDED;
 *  - the upsert carries the filing's own created_ts as routed_at (not now — the
 *    D-013 epoch floor depends on it), the 'su-ideate' sentinel lens, the
 *    scope-derived harness with the bridge's 'papercusp' fallback, and folds
 *    workspace 'default' → the sweep workspace (EI-346);
 *  - created_by backfill from engineer_issues fills NULLs only;
 *  - the ref-scoped outcome sweep classifies a resolved filing the change feed
 *    CANNOT see (no completion-integrity pair — the test-db proxy for the top-500
 *    recency window that hid 48/50 of the live corpus) as won; deprecated ⇒ lost;
 *    open ⇒ pending; and scout_lens_weights stays untouched (D-003);
 *  - IDEMPOTENCY: a second run finds 0 candidates, backfills 0, and leaves the
 *    outcome distribution byte-identical.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
// recordRoutedIdea fire-and-forgets a learning.scout invalidate via a lazy import —
// mock the SSE seam so it is a no-op under test.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { findPreBridgeSuFilings, runSuBackfillSweep, DEFAULT_LEDGER_HARNESS } =
  await import('./su-backfill-sweep');
const { recordRoutedIdea } = await import('./routed-ledger');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-su-backfill-sweep';
const CUTOFF = Date.parse('2026-07-03T00:00:00Z');
const DAY = 86_400_000;

/** Seed one work_items row shaped the way the engineer_issues view expects. */
function seedWorkItem(db: OrgTestDb, row: {
  id: string;
  ws?: string;
  harness?: string;
  status: string;
  createdTs: number;
  title?: string;
  kind?: string;
  suCreatedBy?: string | null;
  improvementKind?: string | null;
  withTerminalPair?: boolean;
}) {
  const ei = row.suCreatedBy !== undefined
    ? { source: 'su', ...(row.suCreatedBy ? { created_by: row.suCreatedBy } : {}) }
    : undefined; // no _ei.source → the view COALESCEs source to 'engineer'
  const payload = {
    ...(row.improvementKind ? { improvementKind: row.improvementKind } : {}),
    ...(ei ? { _ei: ei } : {}),
  };
  return db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind,
       created_ts, updated_ts, payload, terminal_owner, terminal_completion_ref)
    VALUES
      (${row.ws ?? WS}, ${row.harness ?? ''}, ${row.id},
       ${row.title ?? `filing ${row.id}`}, ${row.status}, ${row.kind ?? 'change'},
       ${row.createdTs}, ${row.createdTs + 1000}, ${JSON.stringify(payload)}::text::jsonb,
       ${row.withTerminalPair ? 'someone' : null},
       ${row.withTerminalPair ? 'landed in PR #1' : null})`;
}

describe('P-016 su backfill sweep (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;

    // --- CANDIDATES (pre-cutoff su feature filings, not in the ledger) ---
    // Resolved WITHOUT the completion-integrity pair: invisible to the change feed,
    // visible to the ref-scoped read — the window-fix pin.
    await seedWorkItem(db, {
      id: 'EI-PB-WON', status: 'resolved', createdTs: CUTOFF - 20 * DAY,
      suCreatedBy: 'su-alpha', improvementKind: 'feature',
    });
    await seedWorkItem(db, {
      id: 'EI-PB-LOST', status: 'deprecated', createdTs: CUTOFF - 15 * DAY,
      suCreatedBy: 'su-alpha', improvementKind: 'feature',
    });
    // Harness-scoped (scope 'harness:woodshop') + still open.
    await seedWorkItem(db, {
      id: 'EI-PB-OPEN', status: 'open', createdTs: CUTOFF - 10 * DAY,
      harness: 'woodshop', suCreatedBy: 'su-beta', improvementKind: 'feature',
    });
    // workspace_id 'default' (the tool-dispatch ALS quirk) — must fold under WS.
    await seedWorkItem(db, {
      id: 'EI-PB-DEFAULT-WS', status: 'todo', createdTs: CUTOFF - 5 * DAY,
      ws: 'default', suCreatedBy: 'su-beta', improvementKind: 'feature',
    });

    // --- EXCLUSIONS (each breaks exactly one signature clause) ---
    await seedWorkItem(db, {
      id: 'EI-POST-BRIDGE', status: 'open', createdTs: CUTOFF + DAY,
      suCreatedBy: 'su-alpha', improvementKind: 'feature',
    });
    await seedWorkItem(db, {
      id: 'EI-NON-FEATURE', status: 'open', createdTs: CUTOFF - 5 * DAY,
      suCreatedBy: 'su-alpha', improvementKind: null,
    });
    await seedWorkItem(db, {
      id: 'EI-ENGINEER', status: 'open', createdTs: CUTOFF - 5 * DAY,
      improvementKind: 'feature', // engineer-sourced (no _ei.source)
    });
    // Already ledgered (post-bridge behavior) — excluded from (a); its NULL
    // created_by is leg (b)'s backfill target (engineer_issues carries su-gamma).
    await seedWorkItem(db, {
      id: 'EI-LEDGERED', status: 'resolved', createdTs: CUTOFF - 8 * DAY,
      suCreatedBy: 'su-gamma', improvementKind: 'feature',
    });
    await recordRoutedIdea({
      origin: 'su-ideate', ideaId: 'EI-LEDGERED', lens: 'su-ideate', rail: 'improvement',
      routedRef: 'wi:EI-LEDGERED', harnessSlug: DEFAULT_LEDGER_HARNESS,
      workspaceId: WS, routedAt: CUTOFF - 8 * DAY,
    });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('findPreBridgeSuFilings pins the signature: the 4 candidates, oldest-first, exclusions out', async () => {
    const got = await findPreBridgeSuFilings(CUTOFF);
    expect(got.map((f) => f.issueId)).toEqual([
      'EI-PB-WON', 'EI-PB-LOST', 'EI-PB-OPEN', 'EI-PB-DEFAULT-WS',
    ]);
    const open = got.find((f) => f.issueId === 'EI-PB-OPEN')!;
    expect(open.scope).toBe('harness:woodshop');
    expect(open.createdBy).toBe('su-beta');
    expect(open.createdAtMs).toBe(CUTOFF - 10 * DAY);
    const won = got.find((f) => f.issueId === 'EI-PB-WON')!;
    expect(won.scope).toBe('operator');
  });

  it('the sweep upserts candidates with original routed_at, scope-derived harness, workspace folding; backfills created_by; classifies via the ref-scoped read', async () => {
    const res = await runSuBackfillSweep({ workspaceId: WS, cutoffMs: CUTOFF });

    expect(res.preBridge.candidates).toBe(4);
    expect(res.preBridge.upserted).toEqual([
      'EI-PB-WON', 'EI-PB-LOST', 'EI-PB-OPEN', 'EI-PB-DEFAULT-WS',
    ]);
    // Leg (b): only the pre-existing ledger row was missing created_by (the 4
    // fresh upserts already carry it).
    expect(res.createdByBackfilled).toBe(1);

    const rows = await db.adminSql<
      {
        idea_id: string; origin: string; lens: string; rail: string; routed_ref: string;
        harness_slug: string; workspace_id: string; routed_at: string;
        created_by: string | null; outcome: string | null;
      }[]
    >`
      SELECT idea_id, origin, lens, rail, routed_ref, harness_slug, workspace_id,
             routed_at, created_by, outcome
        FROM harness_shared.scout_routed_ideas
       WHERE workspace_id = ${WS} ORDER BY routed_at`;
    const byId = new Map(rows.map((r) => [r.idea_id, r]));
    expect(rows).toHaveLength(5); // 4 backfilled + the pre-ledgered row; no exclusions

    const won = byId.get('EI-PB-WON')!;
    expect(won).toMatchObject({
      origin: 'su-ideate', lens: 'su-ideate', rail: 'improvement',
      routed_ref: 'wi:EI-PB-WON', harness_slug: DEFAULT_LEDGER_HARNESS,
      created_by: 'su-alpha',
      // The window fix: resolved but feed-invisible (no integrity pair) ⇒ won.
      outcome: 'won',
    });
    expect(Number(won.routed_at)).toBe(CUTOFF - 20 * DAY);

    expect(byId.get('EI-PB-LOST')!.outcome).toBe('lost');
    const open = byId.get('EI-PB-OPEN')!;
    expect(open).toMatchObject({ harness_slug: 'woodshop', created_by: 'su-beta', outcome: 'pending' });
    expect(byId.get('EI-PB-DEFAULT-WS')!.workspace_id).toBe(WS);
    const ledgered = byId.get('EI-LEDGERED')!;
    expect(ledgered.created_by).toBe('su-gamma'); // leg (b) filled the NULL
    expect(ledgered.outcome).toBe('won');

    expect(res.outcomes).toEqual({ won: 2, lost: 1, pending: 2 });
    expect(res.total).toBe(5);

    // D-003: a su-origin sweep never writes lens weights.
    const weights = await db.adminSql<{ n: string }[]>`
      SELECT count(*) AS n FROM harness_shared.scout_lens_weights WHERE workspace_id = ${WS}`;
    expect(Number(weights[0].n)).toBe(0);
  });

  it('IDEMPOTENT: a second run finds nothing to do and the distribution is unchanged', async () => {
    const again = await runSuBackfillSweep({ workspaceId: WS, cutoffMs: CUTOFF });
    expect(again.preBridge.candidates).toBe(0);
    expect(again.preBridge.upserted).toEqual([]);
    expect(again.createdByBackfilled).toBe(0);
    expect(again.outcomes).toEqual({ won: 2, lost: 1, pending: 2 });
    expect(again.total).toBe(5);
  });

  it('dryRun previews without writing', async () => {
    // A fresh candidate appears after the first sweep…
    await seedWorkItem(db, {
      id: 'EI-PB-LATE', status: 'open', createdTs: CUTOFF - 2 * DAY,
      suCreatedBy: 'su-alpha', improvementKind: 'feature',
    });
    const preview = await runSuBackfillSweep({ workspaceId: WS, cutoffMs: CUTOFF, dryRun: true });
    expect(preview.preBridge.candidates).toBe(1);
    expect(preview.preBridge.upserted).toEqual([]);
    // …but dryRun left the ledger untouched.
    const rows = await db.adminSql<{ n: string }[]>`
      SELECT count(*) AS n FROM harness_shared.scout_routed_ideas WHERE workspace_id = ${WS}`;
    expect(Number(rows[0].n)).toBe(5);
  });
});
