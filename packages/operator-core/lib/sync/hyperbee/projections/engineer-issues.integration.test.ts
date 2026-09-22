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
  // Migration 865's real partial arbiter. Most rows in this suite carry no
  // watchdogKey, so installing it globally keeps every test on the production
  // schema while affecting only the focused identity cases below.
  await db.sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS work_items_watchdog_identity_uq
      ON harness_shared.work_items (
        workspace_id,
        harness_slug,
        (payload ->> 'watchdogKey'),
        (COALESCE(payload -> '_ei' ->> 'signal_origin', 'organic')),
        (COALESCE(payload ->> 'lane', 'improvement'))
      )
      WHERE item_kind IN ('bug', 'change', 'task')
        AND (status IS NULL OR status <> ALL (
          ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
        ))
        AND payload ->> 'watchdogKey' IS NOT NULL;

    -- Migration 1157's real keyless admission-identity arbiter (WI-2142873).
    CREATE UNIQUE INDEX IF NOT EXISTS work_items_keyless_title_identity_uq
      ON harness_shared.work_items (workspace_id, harness_slug, (payload #>> '{admissionIdentity,titleKey}'))
      WHERE item_kind IN ('bug', 'change', 'task')
        AND (status IS NULL OR status <> ALL (
          ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
        ))
        AND NULLIF(btrim(payload ->> 'watchdogKey'), '') IS NULL
        AND COALESCE(payload ->> 'lane', 'improvement') <> 'observation'
        AND payload #>> '{admissionIdentity,schemaVersion}' = 'admission-identity-v1'
        AND NULLIF(btrim(payload #>> '{admissionIdentity,titleKey}'), '') IS NOT NULL;

    -- A second partial index gives the negative control teeth: its 23505 must
    -- still escape the projection rather than being mistaken for migration 865.
    CREATE UNIQUE INDEX IF NOT EXISTS engineer_issues_projection_unrelated_uq
      ON harness_shared.work_items (workspace_id, (payload ->> 'projectionTestUnique'))
      WHERE payload ->> 'projectionTestUnique' IS NOT NULL;
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

async function getIssueLifecycle(id: string) {
  const rows = await db.sql<
    {
      state: string;
      title: string;
      origin: string;
      fed_ts: number | null;
      terminal_owner: string | null;
      terminal_completion_ref: string | null;
      authority: string | null;
      payload: Record<string, unknown> | null;
    }[]
  >`
    SELECT state, title, origin, fed_ts, terminal_owner, terminal_completion_ref, authority, payload
      FROM harness_shared.engineer_issues
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

  it('composeKey includes the physical harness for post-829 rows', () => {
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

  it('does not let a later remote open snapshot erase a local terminal result without explicit reopen proof', async () => {
    const p = proj();
    const completionEvidence = {
      summary: 'local completion survived',
      verifiedHow: 'integration test',
      testsRun: 'vitest',
      testResult: 'PASS',
    };
    const assumptions = { declared: 'none', resolvedAt: new Date(100_000).toISOString() };

    await p.writeToPg(
      issueRow({
        issue_id: 'EI-terminal-regression',
        title: 'locally completed item',
        state: 'done',
        terminal_owner: 'agent-local',
        terminal_completion_ref: 'local completion ref',
        authority: 'committed',
        payload: { _completionEvidence: completionEvidence, _assumptions: assumptions },
      }),
      { ts: 100, fedHlc: '100:00000:local', origin: 'local', authorPubkey: 'local-device' },
    );
    const before = await getIssueLifecycle('EI-terminal-regression');

    // This peer never observed the completion. Its later clock makes the op a
    // legitimate LWW winner, but its bare open state is not an intentional reopen.
    await p.writeToPg(
      issueRow({
        issue_id: 'EI-terminal-regression',
        title: 'later stale peer edit',
        state: 'open',
        terminal_owner: null,
        terminal_completion_ref: null,
        authority: null,
        payload: { peerEdit: true },
      }),
      { ts: 200, fedHlc: '200:00000:peer', origin: 'remote', authorPubkey: 'peer-device' },
    );

    expect(await getIssueLifecycle('EI-terminal-regression')).toEqual(before);
  });

  it('accepts a later remote reopen only when its newest history entry archives the exact terminal result', async () => {
    const p = proj();
    const completionEvidence = {
      summary: 'completion intentionally retracted',
      verifiedHow: 'integration test',
      testsRun: 'vitest',
      testResult: 'PASS',
    };
    const assumptions = { declared: 'none', resolvedAt: new Date(100_000).toISOString() };
    await p.writeToPg(
      issueRow({
        issue_id: 'EI-explicit-reopen',
        title: 'locally completed item',
        state: 'done',
        terminal_owner: 'agent-local',
        terminal_completion_ref: 'local completion ref',
        authority: 'committed',
        payload: { _completionEvidence: completionEvidence, _assumptions: assumptions },
      }),
      { ts: 100, fedHlc: '100:00000:local', origin: 'local', authorPubkey: 'local-device' },
    );

    const reopenEntry = {
      at: new Date(200_000).toISOString(),
      by: 'agent-peer',
      force: true,
      prevState: 'done',
      terminalOwner: 'agent-local',
      terminalCompletionRef: 'local completion ref',
      completionAuthority: 'committed',
      terminalCompletionEvidence: completionEvidence,
      assumptions,
    };
    await p.writeToPg(
      issueRow({
        issue_id: 'EI-explicit-reopen',
        title: 'explicitly reopened by peer',
        state: 'open',
        terminal_owner: null,
        terminal_completion_ref: null,
        authority: 'invalid',
        payload: { reopenHistory: [reopenEntry] },
      }),
      { ts: 200, fedHlc: '200:00000:peer', origin: 'remote', authorPubkey: 'peer-device' },
    );

    const after = await getIssueLifecycle('EI-explicit-reopen');
    expect(after).toMatchObject({
      state: 'open',
      title: 'explicitly reopened by peer',
      origin: 'remote',
      fed_ts: 200,
      terminal_owner: null,
      terminal_completion_ref: null,
      authority: 'invalid',
    });
    expect(after?.payload?._completionEvidence).toBeUndefined();
    expect(after?.payload?._assumptions).toBeUndefined();
    expect(after?.payload?.reopenHistory).toEqual([reopenEntry]);
  });

  it('coalesces a stale reopen onto the exact non-terminal watchdog winner and stays idempotent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = proj();
      const watchdogKey = 'federation-drain-stall:ws-ei-proj:papercup';
      const payload = { watchdogKey };

      // This is the live position-45293 shape: an older physical issue has
      // already terminalized, while a newer issue owns its exact effective
      // (workspace, Pot, watchdogKey, organic, improvement) identity.
      await p.writeToPg(
        issueRow({
          issue_id: 'EI-watchdog-loser',
          state: 'resolved',
          title: 'terminal historical signal',
          payload,
        }),
        { ts: 100, fedHlc: '100:00000:peer', origin: 'remote', authorPubkey: 'peer' },
      );
      await p.writeToPg(issueRow({ issue_id: 'EI-watchdog-winner', state: 'open', title: 'live signal', payload }), {
        ts: 200,
        fedHlc: '200:00000:peer',
        origin: 'remote',
        authorPubkey: 'peer',
      });

      const readPair = () => db.sql<{ feature_id: string; status: string; title: string; fed_ts: number | null }[]>`
        SELECT feature_id, status, title, fed_ts
          FROM harness_shared.work_items
         WHERE workspace_id = ${WS}
           AND harness_slug = ${SLUG}
           AND feature_id IN ('EI-watchdog-loser', 'EI-watchdog-winner')
         ORDER BY feature_id`;
      const before = await readPair();

      const staleReopen = issueRow({
        issue_id: 'EI-watchdog-loser',
        state: 'open',
        title: 'stale replay must not reopen or overwrite either row',
        // Carry a structurally valid explicit reopen record so this fixture gets
        // past the terminal-regression guard and still exercises the independent
        // migration-865 unique-index recovery path below. Bare open replays are
        // covered by EI-terminal-regression above and never reach this 23505.
        payload: {
          ...payload,
          reopenHistory: [
            {
              at: new Date(300_000).toISOString(),
              by: 'peer',
              force: true,
              prevState: 'resolved',
              terminalOwner: null,
              terminalCompletionRef: null,
              completionAuthority: null,
              terminalCompletionEvidence: null,
              assumptions: null,
            },
          ],
        },
      });
      const replayProvenance = {
        ts: 300,
        fedHlc: '300:00000:peer',
        origin: 'remote' as const,
        authorPubkey: 'peer',
      };

      await p.writeToPg(staleReopen, replayProvenance);
      expect(await readPair()).toEqual(before);

      // A second fold of the identical poisoned op is the recurrence guard:
      // it is still a no-op and never becomes a new retryable cursor failure.
      await p.writeToPg(staleReopen, replayProvenance);
      expect(await readPair()).toEqual(before);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('winner=EI-watchdog-winner'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // WI-2142873 live shape: a peer that had not replicated an open keyless filing
  // minted a duplicate with the same server-authored titleKey; its replay raised
  // a deterministic 23505 on migration 1157's index and pinned the tower's merge
  // cursor for that peer log (2.7 days, 32k retries).
  it('coalesces a duplicate keyless filing onto the live migration-1157 titleKey winner and stays idempotent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = proj();
      const admissionIdentity = { schemaVersion: 'admission-identity-v1', titleKey: 'bg-host drain stalls on join' };
      await p.writeToPg(
        issueRow({ issue_id: 'EI-keyless-winner', state: 'open', title: 'bg-host drain stalls on join', payload: { admissionIdentity } }),
        { ts: 100, fedHlc: '100:00000:peer', origin: 'remote', authorPubkey: 'peer' },
      );
      const duplicate = issueRow({
        issue_id: 'WI-keyless-dup',
        state: 'open',
        title: 'bg-host drain stalls on join',
        payload: { admissionIdentity },
      });
      const provenance = { ts: 200, fedHlc: '200:00000:vm', origin: 'remote' as const, authorPubkey: 'vm' };

      await p.writeToPg(duplicate, provenance);
      // Recurrence guard: re-folding the identical op is still a no-op, never a
      // new retryable cursor failure.
      await p.writeToPg(duplicate, provenance);

      expect(await getIssue('EI-keyless-winner')).not.toBeNull();
      expect(await getIssue('WI-keyless-dup')).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('winner=EI-keyless-winner'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('migration-1157 fixture index binds only rows inside its predicate (calibration for the coalesce test)', async () => {
    // Calibration: a same-titleKey row OUTSIDE the predicate (another
    // schemaVersion) must land untouched, so the coalesce test above is
    // exercising the real partial arbiter rather than a broader accidental one.
    // Any other index's 23505 still escapes: see the next test.
    const admissionIdentity = { schemaVersion: 'admission-identity-v1', titleKey: 'shared normalized title' };
    const p = proj();
    await p.writeToPg(
      issueRow({ issue_id: 'EI-keyless-live', state: 'open', payload: { admissionIdentity } }),
      { ts: 100, origin: 'remote', authorPubkey: 'peer' },
    );
    // A second live row with a DIFFERENT schemaVersion does not enter the index,
    // so it lands; this proves the fixture exercises the predicate, not a typo.
    await p.writeToPg(
      issueRow({ issue_id: 'EI-keyless-v0', state: 'open', payload: { admissionIdentity: { ...admissionIdentity, schemaVersion: 'v0' } } }),
      { ts: 150, origin: 'remote', authorPubkey: 'peer' },
    );
    expect(await getIssue('EI-keyless-v0')).not.toBeNull();
  });

  it('does not swallow a 23505 from any unique index other than migration 865', async () => {
    const p = proj();
    await p.writeToPg(issueRow({ issue_id: 'EI-unrelated-a', payload: { projectionTestUnique: 'same-value' } }), {
      ts: 100,
      origin: 'remote',
      authorPubkey: 'peer',
    });

    await expect(
      p.writeToPg(issueRow({ issue_id: 'EI-unrelated-b', payload: { projectionTestUnique: 'same-value' } }), {
        ts: 200,
        origin: 'remote',
        authorPubkey: 'peer',
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await getIssue('EI-unrelated-a')).not.toBeNull();
    expect(await getIssue('EI-unrelated-b')).toBeNull();
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
    await p.deleteFromPg('EI-11', 50, undefined, { ts: 50, origin: 'remote', authorPubkey: 'peer' }); // stale del — guarded out
    expect(await getIssue('EI-11')).not.toBeNull();
    await p.deleteFromPg('EI-11', 200, undefined, { ts: 200, origin: 'remote', authorPubkey: 'peer' }); // newer del — applies
    expect(await getIssue('EI-11')).toBeNull();
  });

  it('refuses a bare tombstone when provenance is absent', async () => {
    const p = proj();
    await p.writeToPg(issueRow({ issue_id: 'EI-11-no-provenance' }), {
      ts: 100,
      origin: 'remote',
      authorPubkey: 'peer',
    });

    await p.deleteFromPg('EI-11-no-provenance', 200);

    expect(await getIssue('EI-11-no-provenance')).not.toBeNull();
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

  it('suppresses only legacy PUTs for migration-826 merged/rekeyed sources while allowing a qualified post-829 PUT', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = proj();

      // An identical source row was merged into this survivor by migration 826.
      await p.writeToPg(
        issueRow({
          issue_id: 'EI-826-merged',
          storage_harness_slug: SLUG,
          payload: { _physicalTwinRepair: { migration: 826, sourceHarness: 'sibling-hive' } },
        }),
        { ts: 100, origin: 'remote', authorPubkey: 'peer-survivor' },
      );
      const mergedReplay = issueRow({
        issue_id: 'EI-826-merged',
        scope: 'harness:sibling-hive',
        title: 'legacy replay must not recreate the merged source',
      });
      delete (mergedReplay as { storage_harness_slug?: string }).storage_harness_slug;
      await p.writeToPg(mergedReplay, { ts: 200, origin: 'remote', authorPubkey: 'peer-sibling' });
      expect(await getIssueBaseRows('EI-826-merged')).toEqual([
        { feature_id: 'EI-826-merged', harness_slug: SLUG, status: 'open', origin: 'remote' },
      ]);

      // A divergent source row was rekeyed; the old bare identity is retired.
      await p.writeToPg(
        issueRow({
          issue_id: 'EI-82600000000000999',
          scope: 'harness:sibling-hive',
          storage_harness_slug: 'sibling-hive',
          payload: {
            _physicalTwinRekey: {
              migration: 826,
              oldId: 'EI-826-rekeyed',
              sourceHarness: 'sibling-hive',
            },
          },
        }),
        { ts: 100, origin: 'remote', authorPubkey: 'peer-sibling' },
      );
      const rekeyReplay = issueRow({ issue_id: 'EI-826-rekeyed', scope: 'harness:sibling-hive' });
      delete (rekeyReplay as { storage_harness_slug?: string }).storage_harness_slug;
      await p.writeToPg(rekeyReplay, { ts: 200, origin: 'remote', authorPubkey: 'peer-sibling' });
      expect(await getIssueBaseRows('EI-826-rekeyed')).toHaveLength(0);

      // The same identity on a qualified post-829 key is authoritative and is
      // therefore allowed even though survivor evidence exists.
      await p.writeToPg(
        issueRow({
          issue_id: 'EI-826-merged',
          scope: 'harness:sibling-hive',
          storage_harness_slug: 'sibling-hive',
          title: 'current qualified source row',
        }),
        { ts: 300, origin: 'remote', authorPubkey: 'peer-sibling' },
      );
      expect(await getIssueBaseRows('EI-826-merged')).toEqual([
        { feature_id: 'EI-826-merged', harness_slug: SLUG, status: 'open', origin: 'remote' },
        { feature_id: 'EI-826-merged', harness_slug: 'sibling-hive', status: 'open', origin: 'remote' },
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('suppressing legacy replay'));
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

/**
 * EI-21467654382027859 — the nine columns the federated-column-completeness guard
 * caught landing NULL on every peer.
 *
 * The carrying itself is guarded statically (that drift guard for column→mapper, and
 * issue-wire-capture-mapper-parity for mapper→capture SQL). What NEITHER can see is
 * the ON CONFLICT semantics, which are a SEPARATE per-column decision and are where
 * this class of change actually goes wrong: `admission` and `state_changed_at` both
 * need a floor rather than a bare EXCLUDED, for different reasons, and a bare
 * EXCLUDED would look correct in review and pass every other test in this file.
 */
describe('engineer-issues projection — EI-21467654382027859 federated columns (real PG)', () => {
  const admissionOf = async (id: string) =>
    (
      await db.sql<{ admission: string | null; admitted_by: string | null; state_changed_at: Date | null }[]>`
        SELECT admission, admitted_by, state_changed_at FROM harness_shared.work_items
         WHERE workspace_id = ${WS} AND feature_id = ${id} AND item_kind IN ('bug', 'change', 'task')`
    )[0] ?? null;

  it('carries all nine columns onto a peer (they used to arrive NULL)', async () => {
    await proj().writeToPg(
      issueRow({
        issue_id: 'EI-fed9',
        admission: 'pending',
        admitted_at: null,
        admitted_by: null,
        state_changed_at: new Date(50_000).toISOString(),
        tags: ['triage', 'p2p'],
        parent_id: 'EI-parent',
        source_plan_slug: 'some-plan-2026-08-25',
        source_plan_item_ids: ['P-001', 'P-002'],
        expected_cost_cents: 4200,
      }),
      { ts: 100, fedHlc: '100:00001:a', origin: 'remote', authorPubkey: 'peer' },
    );
    const [r] = await db.sql<
      {
        admission: string | null;
        state_changed_at: Date | null;
        tags: unknown;
        parent_id: string | null;
        source_plan_slug: string | null;
        source_plan_item_ids: string[] | null;
        expected_cost_cents: string | null;
      }[]
    >`SELECT admission, state_changed_at, tags, parent_id, source_plan_slug,
             source_plan_item_ids, expected_cost_cents
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = 'EI-fed9' AND item_kind IN ('bug', 'change', 'task')`;
    expect(r.admission).toBe('pending');
    expect(r.state_changed_at?.getTime()).toBe(50_000);
    expect(r.tags).toEqual(['triage', 'p2p']);
    expect(r.parent_id).toBe('EI-parent');
    expect(r.source_plan_slug).toBe('some-plan-2026-08-25');
    expect(r.source_plan_item_ids).toEqual(['P-001', 'P-002']);
    expect(Number(r.expected_cost_cents)).toBe(4200);
  });

  // THE CORRECTNESS HOLE THIS ITEM CLOSES. The issue claim gate is
  // `admittedWhereSql` = `(admission IS DISTINCT FROM 'pending')`, and there is no
  // origin/quarantine leg on issue claims. So a born-pending row that arrives with
  // admission NULL reads as ADMITTED and becomes claimable on the peer — the gate is
  // not kept local by dropping the column, it is BYPASSED.
  it('a born-pending issue stays pending on the peer — it does not arrive claimable', async () => {
    await proj().writeToPg(issueRow({ issue_id: 'EI-pend', admission: 'pending' }), {
      ts: 100,
      fedHlc: '100:00001:a',
      origin: 'remote',
      authorPubkey: 'peer',
    });
    expect((await admissionOf('EI-pend'))?.admission).toBe('pending');
    // The gate itself, not a proxy for it: this is the exact predicate every issue
    // claim path composes, so a regression here is a claimable born-pending item.
    const [{ visible }] = await db.sql<{ visible: number }[]>`
      SELECT count(*)::int AS visible FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = 'EI-pend'
         AND (admission IS DISTINCT FROM 'pending')`;
    expect(visible).toBe(0);
  });

  // An op from a peer running pre-965 code carries NO admission key. Taking EXCLUDED
  // blindly would write NULL over a local 'pending' — re-opening the same bypass from
  // the other direction, and only for mixed-version fleets, which is exactly the case
  // that would reach production unnoticed.
  it('an op lacking admission does NOT un-hide a locally born-pending row', async () => {
    await proj().writeToPg(issueRow({ issue_id: 'EI-mix', admission: 'pending' }), {
      ts: 100,
      fedHlc: '100:00001:a',
      origin: 'remote',
      authorPubkey: 'peer',
    });
    // Strictly newer op, so it wins the LWW guard and the ON CONFLICT SET really runs.
    const legacy = issueRow({ issue_id: 'EI-mix', title: 'edited by an older peer' });
    delete (legacy as unknown as Record<string, unknown>).admission;
    await proj().writeToPg(legacy, { ts: 900, fedHlc: '900:00001:b', origin: 'remote', authorPubkey: 'peer' });
    const after = await admissionOf('EI-mix');
    expect((await getIssue('EI-mix'))?.title).toBe('edited by an older peer'); // the op DID apply
    expect(after?.admission).toBe('pending'); // …without clearing the gate
  });

  // Promotion is monotonic (no writer anywhere moves admission back to 'pending'), and
  // a LOCAL promotion does not restamp fed_ts/fed_hlc — so a later remote op from a
  // peer that has not seen the promotion legitimately outranks it in fed_order_key
  // space. Without the floor it would re-hide work that was already judged.
  it('a stale pending op does NOT un-admit a row that was already promoted', async () => {
    await proj().writeToPg(issueRow({ issue_id: 'EI-prom', admission: 'pending' }), {
      ts: 100,
      fedHlc: '100:00001:a',
      origin: 'remote',
      authorPubkey: 'peer',
    });
    await db.sql`UPDATE harness_shared.work_items
                    SET admission = 'admitted', admitted_by = 'promoter-local'
                  WHERE workspace_id = ${WS} AND feature_id = 'EI-prom'`;
    await proj().writeToPg(issueRow({ issue_id: 'EI-prom', admission: 'pending', title: 'later edit' }), {
      ts: 900,
      fedHlc: '900:00001:b',
      origin: 'remote',
      authorPubkey: 'peer',
    });
    const after = await admissionOf('EI-prom');
    expect((await getIssue('EI-prom'))?.title).toBe('later edit'); // the op applied
    expect(after?.admission).toBe('admitted'); // …but the promotion survived
    expect(after?.admitted_by).toBe('promoter-local'); // …and so did its provenance
  });

  // mig 896's stamp trigger treats a NULL that DIFFERS from the stored value as "an
  // explicit origin timestamp" and preserves it. So a bare EXCLUDED would let ONE op
  // from an older peer erase the state age the column exists to protect.
  it('an op lacking state_changed_at does NOT erase the stored state age', async () => {
    await proj().writeToPg(issueRow({ issue_id: 'EI-age', state_changed_at: new Date(50_000).toISOString() }), {
      ts: 100,
      fedHlc: '100:00001:a',
      origin: 'remote',
      authorPubkey: 'peer',
    });
    expect((await admissionOf('EI-age'))?.state_changed_at?.getTime()).toBe(50_000);
    const legacy = issueRow({ issue_id: 'EI-age', state: 'done', title: 'older peer closes it' });
    delete (legacy as unknown as Record<string, unknown>).state_changed_at;
    await proj().writeToPg(legacy, { ts: 900, fedHlc: '900:00001:b', origin: 'remote', authorPubkey: 'peer' });
    expect((await getIssue('EI-age'))?.state).toBe('done'); // the op applied
    expect((await admissionOf('EI-age'))?.state_changed_at?.getTime()).toBe(50_000); // age preserved
  });

  // decodeValue is all-or-nothing: a row the validator rejects is discarded WHOLESALE.
  // Making any of the nine required would make an older peer's every issue op
  // undecodable — the defect amended on the sibling `producer` column of
  // EI-21462599108204160, asserted here so it cannot be reintroduced.
  it('the validator still accepts a pre-965 row carrying none of the nine', () => {
    const legacy = issueRow();
    for (const k of [
      'admission',
      'admitted_at',
      'admitted_by',
      'state_changed_at',
      'tags',
      'parent_id',
      'source_plan_slug',
      'source_plan_item_ids',
      'expected_cost_cents',
    ])
      delete (legacy as unknown as Record<string, unknown>)[k];
    expect(_testing.decodeValue(legacy)).not.toBeNull();
  });
});
