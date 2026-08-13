/**
 * engineer-issues projection — the Hyperbee→PG read side for work-queue federation
 * (fed-reanchor brief B5; closes engineer-issues-2026-06-03 D-009). Real PG: applies
 * migs 131 (engineer_issues) + 142 (kind/seq) + 152 (task/payload) + 197 (fed col +
 * capture) and exercises the projection's writeToPg LWW + per-harness demux + delete.
 * The capture/op-key (write side) is proven in __tests__/engineer-issues-federation-
 * trigger.integration.test.ts; this proves the read side applies a remote op where the
 * issues:* surface reads it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, SUBSTRATE_OUTBOX_DDL } from '../../../../test/_work-items-schema';
import { buildEngineerIssuesProjection, _testing, type EngineerIssueRow } from './engineer-issues';

const WS = 'ws-ei-proj';
const SLUG = 'papercup';

function issueRow(over: Partial<EngineerIssueRow> = {}): EngineerIssueRow {
  return {
    harness_slug: SLUG,
    issue_id: 'EI-1',
    scope: `harness:${SLUG}`,
    kind: 'bug',
    title: 'a bug',
    body: 'details',
    severity: 'minor',
    source: 'engineer',
    state: 'open',
    assignee: null,
    assigned_by: null,
    assigned_at: null,
    payload: null,
    found_during: null,
    linked_feature_id: null,
    created_by: null,
    created_at: new Date(1000).toISOString(),
    // WI-6327: post-mig-688 ops carry the authoritative epoch-ms creation instant, and
    // it — not created_at — is what the EI-13285 collision guard compares. Default rows
    // therefore model a CURRENT op; the legacy (created_ts-less) shape is exercised
    // explicitly by the fail-open test below.
    created_ts: 1000,
    ...over,
  };
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('engineer-issues-proj');
  await db.sql.unsafe(`
    DO $r$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
    END $r$;
  `);
  // P-010 unification: work_items base + hfc/ei compat views + the outbox table. The
  // projection applies REMOTE-origin ops (echo-guarded), so no capture trigger is needed.
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(SUBSTRATE_OUTBOX_DDL);
  // WI-183/WI-2845/WI-2853: the shared _work-items-schema.ts fixture deliberately
  // omits stamp_local_federated_write_trg (constraints/triggers are added per-test,
  // not in the shared fixture — see that file's own header). But `work_items` IS a
  // real production carrier of this trigger: mig 214 attached it to
  // `harness_features_consolidated`, and mig 374's `ALTER TABLE
  // harness_features_consolidated RENAME TO work_items` PRESERVES triggers across a
  // rename — so the trigger is live on prod `work_items` today under its original
  // name. Attach the CURRENT (mig 517-fixed) function body verbatim so this test
  // exercises the real prod trigger stack, not a fixture that happens to omit it.
  await db.sql.unsafe(`
    -- Minimal stub (real def = mig 314, needs a harness_shared.hlc_clock singleton
    -- table this fixture doesn't have) — only needs to return a fresh, distinguishable
    -- value each call so the test can prove the trigger DID/DIDN'T re-stamp the clock.
    CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text
      LANGUAGE sql AS $hlc_stub$
        SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || ':stub';
      $hlc_stub$;

    -- Verbatim body of mig 517 (fix-stamp-local-federated-write-mask): the
    -- work_items-scoped extra exclusion of updated_ts/ts, kept table-scoped
    -- because other federated tables sharing this function (e.g. coord_event_log)
    -- have a genuine-content ts column that must NOT be masked globally.
    CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
          NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
        END IF;
        RETURN NEW;
      END IF;
      IF TG_TABLE_NAME = 'work_items' THEN
        IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'updated_ts' - 'ts')
           IS DISTINCT FROM
           (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'updated_ts' - 'ts')
        THEN
          NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
          NEW.fed_hlc := harness_shared.hlc_now();
          NEW.origin := 'local';
        END IF;
        RETURN NEW;
      END IF;
      IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition')
         IS DISTINCT FROM
         (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition')
      THEN
        NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
        NEW.fed_hlc := harness_shared.hlc_now();
        NEW.origin := 'local';
      END IF;
      RETURN NEW;
    END;
    $fn$;

    DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.work_items;
    CREATE TRIGGER stamp_local_federated_write_trg
      BEFORE INSERT OR UPDATE ON harness_shared.work_items
      FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();
  `);
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.work_items WHERE item_kind IN ('bug', 'change', 'task')`;
  await db.sql`DELETE FROM harness_shared.substrate_outbox`;
});

const proj = () => buildEngineerIssuesProjection({ workspaceId: WS, harnessSlug: SLUG, sql: db.sql });

async function getIssue(id: string) {
  const rows = await db.sql<
    { issue_id: string; scope: string; state: string; title: string; origin: string; fed_ts: number | null }[]
  >`
    SELECT issue_id, scope, state, title, origin, fed_ts FROM harness_shared.engineer_issues
     WHERE workspace_id = ${WS} AND issue_id = ${id}`;
  return rows[0] ?? null;
}

async function getIssueTerminal(id: string) {
  const rows = await db.sql<{ terminal_owner: string | null; terminal_completion_ref: string | null }[]>`
    SELECT terminal_owner, terminal_completion_ref FROM harness_shared.engineer_issues
     WHERE workspace_id = ${WS} AND issue_id = ${id}`;
  return rows[0] ?? null;
}

async function getIssueBaseRows(id: string) {
  return db.sql<{ feature_id: string; harness_slug: string; status: string; origin: string }[]>`
    SELECT feature_id, harness_slug, status, origin
      FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND feature_id = ${id} AND item_kind IN ('bug', 'change', 'task')
     ORDER BY harness_slug`;
}

describe('engineer-issues projection — pure helpers', () => {
  it('isEngineerIssueRow / decodeValue accept a valid row, reject malformed', () => {
    expect(_testing.decodeValue(issueRow())).not.toBeNull();
    expect(_testing.decodeValue({ ...issueRow(), harness_slug: '' })).toBeNull();
    expect(_testing.decodeValue({ ...issueRow(), issue_id: 123 })).toBeNull();
    expect(_testing.decodeValue({ ...issueRow(), scope: '' })).toBeNull();
    expect(_testing.decodeValue({ ...issueRow(), assignee: 5 })).toBeNull();
    expect(_testing.decodeValue(null)).toBeNull();
    // payload is jsonb-opaque — a value is fine.
    expect(_testing.decodeValue(issueRow({ payload: { agentSessionId: 'x' } }))).not.toBeNull();
  });
  it('composeKey is the issue_id', () => {
    expect(_testing.composeKey(issueRow({ issue_id: 'EI-42' }))).toBe('EI-42');
  });

  it('composeKey includes the physical harness for post-828 rows', () => {
    expect(_testing.composeKey(issueRow({ issue_id: 'EI-42', storage_harness_slug: 'operator:ws-ei-proj' }))).toBe(
      'operator:ws-ei-proj/EI-42',
    );
  });
});

describe('engineer-issues projection — writeToPg / deleteFromPg (real PG)', () => {
  it('applies a remote op into engineer_issues (issues:* reads it); origin=remote, fed_ts set', async () => {
    await proj().writeToPg(issueRow({ issue_id: 'EI-7', state: 'open', title: 'remote bug' }), {
      ts: 100,
      origin: 'remote',
      authorPubkey: 'peer',
    });
    const r = await getIssue('EI-7');
    expect(r?.title).toBe('remote bug');
    expect(r?.scope).toBe(`harness:${SLUG}`);
    expect(r?.origin).toBe('remote'); // so a local re-edit re-stamps origin=local to refederate
    expect(r?.fed_ts).toBe(100);
  });

  // work-item-status-full-unify-2026-07-19 (P-009, owner hard-req D-001): a remote
  // issue op's terminal_reason (the resolved/closed→done/dropped nuance, mig 638 +
  // the CDC issue wire-shape mig 640) must survive the APPLY into the work_items
  // base table — it was silently DROPPED before this fix (the mapper + projection
  // carried terminal_owner/completion_ref but not terminal_reason). Reads the base
  // table directly (what the projection writes), covering both INSERT + UPSERT.
  it('applies terminal_reason on a terminal issue op — INSERT then UPSERT (P-009/D-001)', async () => {
    const terminalReason = async (id: string) =>
      (
        await db.sql<{ terminal_reason: string | null }[]>`
          SELECT terminal_reason FROM harness_shared.work_items
           WHERE workspace_id = ${WS} AND feature_id = ${id} AND item_kind IN ('bug', 'change', 'task')`
      )[0]?.terminal_reason ?? null;

    // INSERT path: a resolved issue federates in as status='done'+terminal_reason='resolved'.
    await proj().writeToPg(issueRow({ issue_id: 'EI-tr', state: 'done', terminal_reason: 'resolved' }), {
      ts: 100,
      fedHlc: '100:00001:a',
      origin: 'remote',
      authorPubkey: 'peer',
    });
    expect(await terminalReason('EI-tr')).toBe('resolved');

    // UPSERT path: a strictly-newer op flips it (e.g. corrected to closed→dropped).
    // A higher fed_ts/fed_hlc wins the LWW guard, so the ON CONFLICT SET must carry
    // terminal_reason for the new nuance to land.
    await proj().writeToPg(issueRow({ issue_id: 'EI-tr', state: 'dropped', terminal_reason: 'closed' }), {
      ts: 200,
      fedHlc: '200:00001:a',
      origin: 'remote',
      authorPubkey: 'peer',
    });
    expect(await terminalReason('EI-tr')).toBe('closed');

    // A plain (non-nuanced) terminal op carries NULL — no stale nuance retained.
    await proj().writeToPg(issueRow({ issue_id: 'EI-plain', state: 'done' }), {
      ts: 100,
      fedHlc: '100:00001:b',
      origin: 'remote',
      authorPubkey: 'peer',
    });
    expect(await terminalReason('EI-plain')).toBeNull();
  });

  it('stores operator-scope remote issues under operator:<workspace>, never empty harness_slug', async () => {
    await proj().writeToPg(
      issueRow({
        harness_slug: SLUG,
        issue_id: 'EI-operator',
        scope: 'operator',
        state: 'open',
        title: 'operator-scoped remote bug',
      }),
      { ts: 120, origin: 'remote', authorPubkey: 'peer' },
    );

    const r = await getIssue('EI-operator');
    expect(r?.scope).toBe('operator');
    expect(r?.title).toBe('operator-scoped remote bug');
    expect(await getIssueBaseRows('EI-operator')).toEqual([
      { feature_id: 'EI-operator', harness_slug: `operator:${WS}`, status: 'open', origin: 'remote' },
    ]);
  });

  it('drops an op for a different harness (demuxed by harness_slug)', async () => {
    await proj().writeToPg(issueRow({ harness_slug: 'other', issue_id: 'EI-8' }), {
      ts: 1,
      origin: 'remote',
      authorPubkey: 'peer',
    });
    expect(await getIssue('EI-8')).toBeNull();
  });

  it('LWW: a newer fed_ts wins, an older one is dropped', async () => {
    const p = proj();
    await p.writeToPg(issueRow({ issue_id: 'EI-9', title: 'v200' }), {
      ts: 200,
      origin: 'remote',
      authorPubkey: 'peer',
    });
    await p.writeToPg(issueRow({ issue_id: 'EI-9', title: 'v100-stale' }), {
      ts: 100,
      origin: 'remote',
      authorPubkey: 'peer',
    });
    expect((await getIssue('EI-9'))?.title).toBe('v200'); // newer held
    await p.writeToPg(issueRow({ issue_id: 'EI-9', title: 'v300' }), {
      ts: 300,
      origin: 'remote',
      authorPubkey: 'peer',
    });
    expect((await getIssue('EI-9'))?.title).toBe('v300');
  });

  // EI-16756: two peers race a completion of the SAME issue within the same
  // federation order key (equal fed_hlc, unknown/matching writer — the tie branch
  // of fed_apply_wins). Both ops converge to IDENTICAL business content (status
  // 'resolved', assignee cleared) but carry DIFFERENT terminal_owner/
  // terminal_completion_ref — the completion-integrity attribution pair. The
  // apply-guard's content digest MUST include those two columns: excluding them
  // (the pre-fix shape) makes the two ops hash to the SAME digest even though
  // they are not identical, which breaks the tie-break's "equal digest ⇒
  // identical content ⇒ applying is a no-op" invariant and makes the winner
  // depend on APPLY ORDER (last-applied-wins) instead of content — a genuine
  // peer sees the two ops in the OPPOSITE order the origin sees them (normal in
  // a gossip network) and diverges permanently (composition-chaos P-002 class).
  it('EI-16756: racing completions with an equal order key converge on the SAME terminal_owner regardless of apply order', async () => {
    const base = issueRow({ issue_id: 'EI-16756', state: 'open', title: 'race me' });
    // Same fedHlc on both ops ⇒ EQUAL fed_order_key; authorPubkey null on both ⇒
    // the "unknown writer" branch, which falls through to the content digest —
    // exactly the vulnerable branch.
    // authorPubkey: '' is the documented sentinel for "a remote op carries no
    // source key" (ProvenanceContext) — both ops sharing it puts this on the
    // "unknown writer" tie branch the test targets.
    const provenance = { ts: 700, fedHlc: '700:00042:tie', origin: 'remote' as const, authorPubkey: '' };
    const opA = { ...base, state: 'resolved', terminal_owner: 'agent-a', terminal_completion_ref: 'fixed by agent-a' };
    const opB = { ...base, state: 'resolved', terminal_owner: 'agent-b', terminal_completion_ref: 'fixed by agent-b' };

    await proj().writeToPg(opA, provenance);
    await proj().writeToPg(opB, provenance);
    const abOrder = await getIssueTerminal('EI-16756');

    await db.sql`DELETE FROM harness_shared.work_items WHERE feature_id = 'EI-16756'`;

    await proj().writeToPg(opB, provenance);
    await proj().writeToPg(opA, provenance);
    const baOrder = await getIssueTerminal('EI-16756');

    // Whichever op "wins" the tie, BOTH apply orders must agree on who — a peer
    // that received the two ops in the opposite order from the origin must not
    // end up attributing the completion to a different agent.
    expect(abOrder?.terminal_owner).toBe(baOrder?.terminal_owner);
    expect(abOrder?.terminal_completion_ref).toBe(baOrder?.terminal_completion_ref);
    // And the stored ref must actually belong to the stored owner (never a
    // mix-and-match of one op's owner with the other op's completion text).
    const expectedRef = abOrder?.terminal_owner === 'agent-a' ? 'fixed by agent-a' : 'fixed by agent-b';
    expect(abOrder?.terminal_completion_ref).toBe(expectedRef);
  });

  // EI-13285: two INDEPENDENT writers (this device's local capture + a Hive peer's
  // own local allocation) can allocate the SAME EI-<n> id with zero coordination
  // (nextIssueId's old MAX-scan allocator was only unique per-Postgres-instance).
  // When the peer's op later federates in, it must NOT be treated as an edit of the
  // pre-existing distinct local record just because the id matches — created_at
  // (part of the federated document, never touched by an UPDATE) is the tell: a
  // genuine edit always carries the SAME created_at as what's already stored; a
  // colliding, unrelated issue carries a DIFFERENT one.
  it('refuses to apply a remote op whose created_at disagrees with the existing row — a distinct-entity id collision (EI-13285)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = proj();
      // The local row: created first, at t=1000 (issueRow()'s default created_at).
      await p.writeToPg(issueRow({ issue_id: 'EI-13236', title: 'freshly captured local improvement' }), {
        ts: 100,
        origin: 'remote',
        authorPubkey: 'peer-a',
      });
      expect((await getIssue('EI-13236'))?.title).toBe('freshly captured local improvement');

      // A colliding remote op for the SAME id, but a genuinely DIFFERENT issue
      // (different created_at) — even with a NEWER fed_ts that would otherwise win
      // the LWW race, it must be dropped, not applied.
      await p.writeToPg(
        issueRow({
          issue_id: 'EI-13236',
          title: 'unrelated remote replication-liveness issue',
          state: 'resolved',
          created_at: new Date(999_000).toISOString(),
          created_ts: 999_000,
        }),
        { ts: 999, origin: 'remote', authorPubkey: 'peer-b' },
      );
      const afterCollision = await getIssue('EI-13236');
      expect(afterCollision?.title).toBe('freshly captured local improvement'); // NOT clobbered
      expect(afterCollision?.fed_ts).toBe(100); // the peer-b write never applied at all
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EI-13285 id collision'));

      // A genuine follow-up edit of the SAME issue (identical created_at, newer
      // fed_ts) must still apply normally — the guard must not block real convergence.
      await p.writeToPg(issueRow({ issue_id: 'EI-13236', title: 'edited by the same author', state: 'resolved' }), {
        ts: 999,
        origin: 'remote',
        authorPubkey: 'peer-a',
      });
      const afterRealEdit = await getIssue('EI-13236');
      expect(afterRealEdit?.title).toBe('edited by the same author');
      expect(afterRealEdit?.state).toBe('resolved');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // WI-6327 — the production failure the EI-13285 guard actually produced. The capture
  // trigger never emitted a creation timestamp for the issue family, so the drain
  // fabricated `created_at: new Date().toISOString()` on EVERY op. The guard compared
  // that drain-time "now" against the local row's real created_ts, found them days
  // apart, and refused the write — for 10,070 distinct issue_ids on the P-302 rig. No
  // issue update could land on a peer that already held the row: claims, state changes
  // and completion evidence all silently stopped converging (~1GB/hr of warnings was the
  // only outward sign).
  //
  // A pre-688 op is indistinguishable from a genuine collision on timestamp alone — its
  // fabricated created_at looks exactly like a different issue's real one — so the guard
  // must key on `created_ts`, which only an authoritative op carries, and FAIL OPEN when
  // it is absent. Refusing a write is the destructive branch; it needs evidence, not a
  // value the mapper invented.
  it('APPLIES a legacy op that carries no created_ts — the guard fails open rather than judging a fabricated timestamp (WI-6327)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = proj();
      await p.writeToPg(issueRow({ issue_id: 'EI-6327', title: 'original' }), {
        ts: 100,
        origin: 'remote',
        authorPubkey: 'peer-a',
      });

      // The legacy shape: no created_ts, and a created_at that (like every pre-688 op)
      // disagrees wildly with the stored row because it was stamped at drain time.
      const legacy = issueRow({
        issue_id: 'EI-6327',
        title: 'a genuine later edit, shipped by a pre-688 peer',
        state: 'resolved',
        created_at: new Date(Date.now()).toISOString(),
      });
      delete (legacy as { created_ts?: number | null }).created_ts;

      await p.writeToPg(legacy, { ts: 500, origin: 'remote', authorPubkey: 'peer-a' });

      const after = await getIssue('EI-6327');
      expect(after?.title).toBe('a genuine later edit, shipped by a pre-688 peer');
      expect(after?.state).toBe('resolved');
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('EI-13285 id collision'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('deleteFromPg removes by issue_id (ts-guarded)', async () => {
    const p = proj();
    await p.writeToPg(issueRow({ issue_id: 'EI-11' }), { ts: 100, origin: 'remote', authorPubkey: 'peer' });
    await p.deleteFromPg('EI-11', 50); // stale del — guarded out
    expect(await getIssue('EI-11')).not.toBeNull();
    await p.deleteFromPg('EI-11', 200); // newer del — applies
    expect(await getIssue('EI-11')).toBeNull();
  });

  it('a harness-qualified tombstone deletes only the exact authored twin', async () => {
    const p = proj();
    const sameId = 'EI-826-twin';
    await p.writeToPg(issueRow({ issue_id: sameId, storage_harness_slug: SLUG }), {
      ts: 100,
      origin: 'remote',
      authorPubkey: 'peer-papercup',
    });
    await p.writeToPg(
      issueRow({
        issue_id: sameId,
        scope: 'harness:sibling-hive',
        storage_harness_slug: 'sibling-hive',
      }),
      { ts: 100, origin: 'remote', authorPubkey: 'peer-sibling' },
    );

    await p.deleteFromPg(`${SLUG}/${sameId}`, 200, undefined, {
      ts: 200,
      origin: 'remote',
      authorPubkey: 'peer-papercup',
    });

    expect(await getIssueBaseRows(sameId)).toEqual([
      {
        feature_id: sameId,
        harness_slug: 'sibling-hive',
        status: 'open',
        origin: 'remote',
      },
    ]);
  });

  it('a legacy bare tombstone cannot erase a same-id row from another author', async () => {
    const p = proj();
    const sameId = 'EI-826-legacy';
    await p.writeToPg(issueRow({ issue_id: sameId }), {
      ts: 100,
      origin: 'remote',
      authorPubkey: 'peer-survivor',
    });

    await p.deleteFromPg(sameId, 200, undefined, {
      ts: 200,
      origin: 'remote',
      authorPubkey: 'peer-deleted-twin',
    });

    expect(await getIssueBaseRows(sameId)).toHaveLength(1);
  });

  it('refuses a put whose storage key disagrees with its scope-derived harness', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await proj().writeToPg(
        issueRow({
          issue_id: 'EI-826-mismatch',
          scope: `harness:${SLUG}`,
          storage_harness_slug: 'sibling-hive',
        }),
        { ts: 100, origin: 'remote', authorPubkey: 'peer' },
      );
      expect(await getIssueBaseRows('EI-826-mismatch')).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('storage harness mismatch'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // WI-183/WI-2845/WI-2853: same-op DOUBLE-APPLY (a replayed/re-folded remote op —
  // e.g. a projection retry or backfill re-running the identical wire op) must be an
  // idempotent no-op on the row's federation state. This writes DIRECTLY to
  // harness_shared.work_items (the P-010 unified base table — engineer_issues is a
  // compat view over it, projections/engineer-issues.ts's own header), so the
  // relevant guard is fed_apply_wins() (mig 504) + the writer's explicit
  // origin/fed_ts/fed_hlc = EXCLUDED.* — NOT the stamp_local_federated_write trigger
  // (that BEFORE trigger is never attached to work_items post-374; confirmed by
  // grepping every `CREATE TRIGGER stamp_local_federated_write_trg` migration).
  it('a same-op double-apply (identical remote op re-folded) does NOT flip origin/fed_ts/fed_hlc', async () => {
    const p = proj();
    const op = issueRow({ issue_id: 'EI-183', title: 'stable content', state: 'open' });
    const provenance = { ts: 500, fedHlc: '500:00000:peer', origin: 'remote' as const, authorPubkey: 'peer' };
    await p.writeToPg(op, provenance);
    const first = await getIssue('EI-183');
    expect(first?.origin).toBe('remote');
    expect(first?.fed_ts).toBe(500);

    // Re-fold the IDENTICAL op a second time (a retry/backfill re-applying the same
    // wire op) — must be a no-op on origin/fed_ts, never flip to 'local' nor advance
    // the LWW clock, even though the write touches bookkeeping columns (updated_ts).
    await p.writeToPg(op, provenance);
    const second = await getIssue('EI-183');
    expect(second?.origin).toBe('remote'); // must NOT flip to 'local'
    expect(second?.fed_ts).toBe(500); // must NOT advance
    expect(second?.title).toBe('stable content');
  });
});
