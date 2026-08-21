/**
 * tick-ledger.integration.test.ts — the Scout tick ledger (migration 208's
 * harness_shared.scout_ticks) against real Postgres. Validates recordScoutTick's
 * INSERT + readScoutTicks' newest-first / workspace-scoped / installSlug-filtered
 * read + the camelCase + spend/detail mapping against the full migrated schema.
 *
 * Follows the established org-fixture pattern (see attention/triage-store.integration.test.ts):
 * the runtime seam routes through getOrgPg().sql as the table owner, so we mock it
 * to the fixture's admin (RLS-bypass) client and mock the workspace resolver. The
 * fire-and-forget sync-sse push is mocked to a no-op (operator-core is fail-on-console).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-scout-default' }));

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: () => Promise.resolve() }));

// Imported AFTER the mocks are declared (vi.mock is hoisted above imports).
const { recordScoutTick, readScoutTicks, readLastRanTickAtMs, readNewestScoutCodeHash, readScoutTicksByCodeHash } =
  await import('./tick-ledger');
const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('scout_ticks ledger (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('records a full "ran" tick and reads it back with counts, spend, and detail mapped', async () => {
    const ws = 'ws-scout-ran';
    await recordScoutTick({
      workspaceId: ws,
      installSlug: 'harness-1',
      status: 'ran',
      ideasGenerated: 5,
      ideasRouted: 3,
      ideasDeduped: 2,
      budgetUsedUsd: 0.42,
      detail: { cycleId: 'c1', reason: 'full cycle' },
    });
    const rows = await readScoutTicks({ workspaceId: ws });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'ran',
      installSlug: 'harness-1',
      ideasGenerated: 5,
      ideasRouted: 3,
      ideasDeduped: 2,
      budgetUsedUsd: 0.42,
      detail: { cycleId: 'c1', reason: 'full cycle' },
    });
    expect(typeof rows[0].tickAt).toBe('string');
    expect(Number.isNaN(Date.parse(rows[0].tickAt))).toBe(false);
  });

  it('records a "gated" tick: gate is named, spend + detail omitted, counts default to 0', async () => {
    const ws = 'ws-scout-gated';
    await recordScoutTick({ workspaceId: ws, status: 'gated', gate: 'min-interval' });
    const rows = await readScoutTicks({ workspaceId: ws });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('gated');
    expect(rows[0].gate).toBe('min-interval');
    expect(rows[0].ideasGenerated).toBe(0);
    expect(rows[0].budgetUsedUsd).toBeUndefined();
    expect(rows[0].detail).toBeUndefined();
  });

  it('reads newest-first', async () => {
    const ws = 'ws-scout-order';
    await recordScoutTick({ workspaceId: ws, status: 'gated', gate: 'first' });
    await new Promise((r) => setTimeout(r, 25)); // distinct tick_at (now() = statement time)
    await recordScoutTick({ workspaceId: ws, status: 'gated', gate: 'second' });
    const rows = await readScoutTicks({ workspaceId: ws });
    expect(rows).toHaveLength(2);
    expect(rows[0].gate).toBe('second');
    expect(rows[1].gate).toBe('first');
  });

  it('is workspace-scoped — another workspace\'s ticks are not returned', async () => {
    await recordScoutTick({ workspaceId: 'ws-scout-iso-a', status: 'ran' });
    await recordScoutTick({ workspaceId: 'ws-scout-iso-b', status: 'ran' });
    expect(await readScoutTicks({ workspaceId: 'ws-scout-iso-a' })).toHaveLength(1);
    expect(await readScoutTicks({ workspaceId: 'ws-scout-iso-b' })).toHaveLength(1);
  });

  it('filters by installSlug when given', async () => {
    const ws = 'ws-scout-slug';
    await recordScoutTick({ workspaceId: ws, status: 'ran', installSlug: 'alpha' });
    await recordScoutTick({ workspaceId: ws, status: 'ran', installSlug: 'beta' });
    const alpha = await readScoutTicks({ workspaceId: ws, installSlug: 'alpha' });
    expect(alpha).toHaveLength(1);
    expect(alpha[0].installSlug).toBe('alpha');
  });

  it('caps the read at the requested limit (newest-first)', async () => {
    const ws = 'ws-scout-limit';
    for (let i = 0; i < 3; i++) await recordScoutTick({ workspaceId: ws, status: 'gated', gate: `g${i}` });
    expect(await readScoutTicks({ workspaceId: ws, limit: 2 })).toHaveLength(2);
  });

  // EI-1600: the cadence floor must be measured from the last cycle that ACTUALLY
  // RAN, not from later fire-attempt activity that never ran a cycle. These pin
  // readLastRanTickAtMs: it returns the last 'ran'/'fired' tick and IGNORES the
  // 'gated'/'error' ticks that followed it (the exact shape of the dormancy bug —
  // an old 'ran' then a long tail of gated/error ticks).
  describe('readLastRanTickAtMs (cadence clock = last RUN)', () => {
    it('returns the last RAN tick, ignoring later gated/error ticks', async () => {
      const ws = 'ws-scout-lastran';
      const slug = '@singleton';
      await recordScoutTick({ workspaceId: ws, installSlug: slug, status: 'ran', ideasGenerated: 3 });
      await new Promise((r) => setTimeout(r, 25));
      const ranAt = await readLastRanTickAtMs({ workspaceId: ws, installSlugs: [slug] });
      // …then a long tail of NON-run ticks (gated min-interval + an error) — the
      // dormancy signature. The cadence clock must NOT advance past the real run.
      await new Promise((r) => setTimeout(r, 25));
      await recordScoutTick({ workspaceId: ws, installSlug: slug, status: 'gated', gate: 'min-interval' });
      await recordScoutTick({ workspaceId: ws, installSlug: slug, status: 'error', detail: { error: 'boom' } });
      const after = await readLastRanTickAtMs({ workspaceId: ws, installSlugs: [slug] });
      expect(ranAt).not.toBeNull();
      // The later gated/error ticks did not move the cadence clock forward.
      expect(after).toBe(ranAt);
    });

    it('returns null when a cycle has never run (only gated/error ticks)', async () => {
      const ws = 'ws-scout-neverran';
      await recordScoutTick({ workspaceId: ws, installSlug: 's', status: 'gated', gate: 'min-interval' });
      await recordScoutTick({ workspaceId: ws, installSlug: 's', status: 'error', detail: { error: 'x' } });
      expect(await readLastRanTickAtMs({ workspaceId: ws, installSlugs: ['s'] })).toBeNull();
    });

    it('reconciles across install_slug read-fallback keys (K1 sentinel/legacy split)', async () => {
      const ws = 'ws-scout-reconcile';
      // The true last run is under the legacy per-hive slug; the sentinel slug only
      // has non-run ticks. A read across BOTH keys must still find the run.
      await recordScoutTick({ workspaceId: ws, installSlug: 'legacy-hive', status: 'ran' });
      await new Promise((r) => setTimeout(r, 25));
      await recordScoutTick({ workspaceId: ws, installSlug: ws, status: 'gated', gate: 'min-interval' });
      expect(await readLastRanTickAtMs({ workspaceId: ws, installSlugs: ['legacy-hive'] })).not.toBeNull();
      expect(await readLastRanTickAtMs({ workspaceId: ws, installSlugs: [ws] })).toBeNull();
      // Reconciled across both keys → resolves the run under the legacy slug.
      expect(await readLastRanTickAtMs({ workspaceId: ws, installSlugs: [ws, 'legacy-hive'] })).not.toBeNull();
    });
  });

  // P-010 (migration 571): su-ideate ticks share this ledger but Scout readers
  // filter origin='scout'. A su-ideate 'ran' tick must be invisible to the Scout
  // read AND must NOT reset the Scout cadence clock (else a su pass would gate the
  // next real Scout cycle as 'min-interval' — the EI-1600 dark-Scout failure).
  describe('origin partition (su-ideate vs scout)', () => {
    it("hides su-ideate ticks from the default (scout) read, but shows them under origin:'su-ideate'", async () => {
      const ws = 'ws-scout-origin';
      await recordScoutTick({ workspaceId: ws, status: 'ran', installSlug: 's', ideasRouted: 4, ideasGenerated: 9 });
      await recordScoutTick({
        workspaceId: ws,
        status: 'ran',
        origin: 'su-ideate',
        installSlug: 's',
        ideasRouted: 2,
        ideasGenerated: 7,
        detail: { owner: 'su-x' },
      });
      const scout = await readScoutTicks({ workspaceId: ws });
      expect(scout).toHaveLength(1);
      expect(scout[0].ideasRouted).toBe(4);
      const ideate = await readScoutTicks({ workspaceId: ws, origin: 'su-ideate' });
      expect(ideate).toHaveLength(1);
      expect(ideate[0]).toMatchObject({ ideasRouted: 2, ideasGenerated: 7, detail: { owner: 'su-x' } });
    });

    it("a su-ideate 'ran' tick does NOT reset the Scout cadence clock", async () => {
      const ws = 'ws-scout-origin-cadence';
      const slug = '@singleton';
      await recordScoutTick({ workspaceId: ws, installSlug: slug, status: 'ran' });
      await new Promise((r) => setTimeout(r, 25));
      const scoutRanAt = await readLastRanTickAtMs({ workspaceId: ws, installSlugs: [slug] });
      // A su-ideate run lands AFTER — it must not advance the Scout cadence clock.
      await new Promise((r) => setTimeout(r, 25));
      await recordScoutTick({ workspaceId: ws, installSlug: slug, status: 'ran', origin: 'su-ideate' });
      const after = await readLastRanTickAtMs({ workspaceId: ws, installSlugs: [slug] });
      expect(scoutRanAt).not.toBeNull();
      expect(after).toBe(scoutRanAt);
      // …but the su-ideate partition DOES see its own run.
      expect(
        await readLastRanTickAtMs({ workspaceId: ws, installSlugs: [slug], origin: 'su-ideate' }),
      ).not.toBeNull();
    });
  });

  // WI-5397: the soak-method fix reads `detail->>'scoutCodeHash'` (stamped by
  // scheduler.ts's recordTick on every tick, see scout-code-identity.ts) to aggregate
  // ticks across bg-host restarts that loaded byte-identical code, UNBOUNDED by time —
  // replacing the rolling time window the cycle-error-rate bar otherwise resets on every
  // restart (fact alpha-011-soak-unreachable-as-planned). These pin the two readers
  // against the real JSONB column.
  describe('scoutCodeHash soak-method readers (WI-5397)', () => {
    it('readNewestScoutCodeHash returns the newest tick\'s stamped hash, workspace + origin scoped', async () => {
      const ws = 'ws-scout-codehash-newest';
      await recordScoutTick({ workspaceId: ws, status: 'ran', detail: { cycleId: 'c1', scoutCodeHash: 'hash-old' } });
      await new Promise((r) => setTimeout(r, 25));
      await recordScoutTick({ workspaceId: ws, status: 'ran', detail: { cycleId: 'c2', scoutCodeHash: 'hash-new' } });
      expect(await readNewestScoutCodeHash({ workspaceId: ws })).toBe('hash-new');
    });

    it('readNewestScoutCodeHash is null when the newest tick never stamped a hash (pre-WI-5397 row)', async () => {
      const ws = 'ws-scout-codehash-absent';
      await recordScoutTick({ workspaceId: ws, status: 'gated', gate: 'min-interval' });
      expect(await readNewestScoutCodeHash({ workspaceId: ws })).toBeNull();
    });

    it('readNewestScoutCodeHash respects installSlug scoping', async () => {
      const ws = 'ws-scout-codehash-slug';
      await recordScoutTick({
        workspaceId: ws,
        installSlug: 'alpha',
        status: 'ran',
        detail: { scoutCodeHash: 'hash-alpha' },
      });
      await recordScoutTick({
        workspaceId: ws,
        installSlug: 'beta',
        status: 'ran',
        detail: { scoutCodeHash: 'hash-beta' },
      });
      expect(await readNewestScoutCodeHash({ workspaceId: ws, installSlug: 'alpha' })).toBe('hash-alpha');
      expect(await readNewestScoutCodeHash({ workspaceId: ws, installSlug: 'beta' })).toBe('hash-beta');
    });

    it('readScoutTicksByCodeHash returns the UNION of code-identical ticks UNBOUNDED by time, excluding a different hash', async () => {
      const ws = 'ws-scout-codehash-union';
      // Two "generations" (simulating two bg-host restarts) that happened to load the
      // SAME code, interleaved with a tick from a DIFFERENT code hash.
      await recordScoutTick({ workspaceId: ws, status: 'ran', detail: { cycleId: 'gen1-a', scoutCodeHash: 'hash-x' } });
      await recordScoutTick({ workspaceId: ws, status: 'error', detail: { cycleId: 'gen1-b', scoutCodeHash: 'hash-x' } });
      await recordScoutTick({ workspaceId: ws, status: 'ran', detail: { cycleId: 'gen2-a', scoutCodeHash: 'hash-y' } });
      await recordScoutTick({ workspaceId: ws, status: 'ran', detail: { cycleId: 'gen3-a', scoutCodeHash: 'hash-x' } });
      const union = await readScoutTicksByCodeHash({ workspaceId: ws, codeHash: 'hash-x' });
      expect(union).toHaveLength(3);
      const cycleIds = union.map((t) => (t.detail as { cycleId?: string } | undefined)?.cycleId).sort();
      expect(cycleIds).toEqual(['gen1-a', 'gen1-b', 'gen3-a']);
    });

    it('readScoutTicksByCodeHash never returns a tick from a different origin partition', async () => {
      const ws = 'ws-scout-codehash-origin';
      await recordScoutTick({ workspaceId: ws, status: 'ran', detail: { scoutCodeHash: 'hash-shared' } });
      await recordScoutTick({
        workspaceId: ws,
        status: 'ran',
        origin: 'su-ideate',
        detail: { scoutCodeHash: 'hash-shared' },
      });
      expect(await readScoutTicksByCodeHash({ workspaceId: ws, codeHash: 'hash-shared' })).toHaveLength(1);
    });

    it('is workspace-scoped — another workspace\'s code-identical ticks never leak in', async () => {
      await recordScoutTick({ workspaceId: 'ws-scout-codehash-iso-a', status: 'ran', detail: { scoutCodeHash: 'hash-shared-2' } });
      await recordScoutTick({ workspaceId: 'ws-scout-codehash-iso-b', status: 'ran', detail: { scoutCodeHash: 'hash-shared-2' } });
      expect(
        await readScoutTicksByCodeHash({ workspaceId: 'ws-scout-codehash-iso-a', codeHash: 'hash-shared-2' }),
      ).toHaveLength(1);
    });

    // WI-5451: the union must INTERSECT with a caller-requested `sinceMs` floor, never let
    // the code-hash predicate alone re-admit a tick from before it — the live defect: a
    // watermarkRef floor was silently ignored because the union answered "same code?" without
    // also asking "at/after the floor?", letting a pre-restart, code-identical tick (contaminated
    // per WI-5442) count as evidence for the running generation.
    describe('sinceMs floor intersects with the code-hash predicate (WI-5451)', () => {
      it('readScoutTicksByCodeHash EXCLUDES a pre-floor tick sharing the same hash as a post-floor tick', async () => {
        const ws = 'ws-scout-codehash-floor';
        await recordScoutTick({
          workspaceId: ws,
          status: 'ran',
          detail: { cycleId: 'pre-floor', scoutCodeHash: 'hash-x' },
        });
        await new Promise((r) => setTimeout(r, 25));
        const floorMs = Date.now();
        await new Promise((r) => setTimeout(r, 25));
        await recordScoutTick({
          workspaceId: ws,
          status: 'ran',
          detail: { cycleId: 'post-floor', scoutCodeHash: 'hash-x' },
        });
        // Un-floored (the pre-WI-5451 / default rolling-window path): both ticks union in.
        const unfloored = await readScoutTicksByCodeHash({ workspaceId: ws, codeHash: 'hash-x' });
        expect(unfloored).toHaveLength(2);
        // Floored: ONLY the post-floor tick counts — the pre-floor tick is excluded even
        // though it shares the exact same code hash.
        const floored = await readScoutTicksByCodeHash({ workspaceId: ws, codeHash: 'hash-x', sinceMs: floorMs });
        expect(floored).toHaveLength(1);
        expect((floored[0].detail as { cycleId?: string } | undefined)?.cycleId).toBe('post-floor');
      });

      it('readNewestScoutCodeHash floored to a point with NO tick since it returns null — never the previous generation\'s hash', async () => {
        const ws = 'ws-scout-codehash-floor-newest';
        await recordScoutTick({ workspaceId: ws, status: 'ran', detail: { cycleId: 'old', scoutCodeHash: 'hash-old-gen' } });
        await new Promise((r) => setTimeout(r, 25));
        const floorMs = Date.now();
        // Un-floored still resolves the (stale) previous generation's hash.
        expect(await readNewestScoutCodeHash({ workspaceId: ws })).toBe('hash-old-gen');
        // Floored at a point after the only tick: no evidence yet for "the running generation" —
        // UNKNOWN is correct here, never silently naming the prior generation as current.
        expect(await readNewestScoutCodeHash({ workspaceId: ws, sinceMs: floorMs })).toBeNull();
        // Once a post-floor tick lands, the floored read picks it up correctly.
        await recordScoutTick({ workspaceId: ws, status: 'ran', detail: { cycleId: 'new', scoutCodeHash: 'hash-new-gen' } });
        expect(await readNewestScoutCodeHash({ workspaceId: ws, sinceMs: floorMs })).toBe('hash-new-gen');
      });
    });
  });
});
