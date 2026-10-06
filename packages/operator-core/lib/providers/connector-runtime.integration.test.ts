/**
 * R-3 — one host-owned connector sync runtime
 * (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05, P-004).
 *
 * A scripted fake provider is registered in a real provider registry and driven
 * through restarts, a provider dying mid-page, expired cursors, duplicate pages,
 * edits, deletes and 429 responses. Every assertion reads the REAL ingestion
 * ledger (`harness_shared.trigger_deliveries`) and the real lease/cursor/backoff
 * columns on `harness_shared.data_sources` (migration 1360).
 *
 * The falsifiers this file pins (R-3): a replay duplicates a delivery, an
 * interrupted sync skips an object, a rate-limited provider advances an
 * uncommitted cursor, or a provider that dies mid-page leaves a cursor committed
 * past undelivered objects.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  HostFetch,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderRecord,
  ProviderSyncPage,
  ProviderSyncRequest,
} from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../external-triggers/ingestion';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import {
  connectorRecordDedupeKey,
  formatConnectorSyncLog,
  ProviderSyncFailure,
  runConnectorSync,
  wakeConnectorSource,
  type ConnectorSyncDeps,
  type ConnectorSyncResult,
} from './connector-runtime';

const WS = 'connector-runtime-test';
const KIND = 'connector-fixture';
const DRIVER = 'driver-a';
const OCCURRED_AT = '2026-10-01T09:00:00Z';

const descriptor: ProviderDescriptor = {
  id: KIND,
  contractVersion: 1,
  datatypes: ['email-message'],
  capabilities: ['mail.read'],
  egressHosts: ['graph.microsoft.com', 'login.microsoftonline.com'],
  oauth: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['Mail.Read'],
    pkce: true,
  },
};

let org: OrgTestDb;
let registry: ProviderRegistry;
/** The provider's behaviour for the current test. */
let handler: (req: ProviderSyncRequest) => Promise<ProviderSyncPage>;
/** Every syncPage call the driver made, in order. */
let calls: Array<{ cursor: string | null; mode: string }>;
/** Dedupe key of every REAL event-bus delivery (a deduped replay never emits). */
let emitted: string[];
/** Simulates the host dying while admitting a page: throw once this many records were admitted. */
let crashIngestAfter: number | null;
let ingestCalls: number;

const adapter: ProviderAdapter = {
  describe: () => descriptor,
  syncPage: async (req) => {
    calls.push({ cursor: req.cursor, mode: req.mode });
    return handler(req);
  },
  invoke: async () => ({ ok: true }),
};

const noNetwork = (async () => {
  throw new Error('connector-runtime test: the fake provider never fetches');
}) as unknown as HostFetch;

async function ingest(sql: OrgTestDb['adminSql'], input: IngestExternalTriggerInput) {
  if (crashIngestAfter !== null && ingestCalls >= crashIngestAfter) {
    throw new Error('host process died while admitting the page');
  }
  ingestCalls += 1;
  return ingestExternalTriggerEvent(sql, input, {
    emit: async (event) => {
      emitted.push(String((event.payload as { dedupeKey?: unknown } | undefined)?.dedupeKey));
      return { ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 };
    },
  });
}

function deps(overrides: Partial<ConnectorSyncDeps> = {}): ConnectorSyncDeps {
  return {
    registry,
    ingest,
    sinksFor: async () => [],
    hostFetchFor: () => noNetwork,
    leaseOwner: DRIVER,
    ...overrides,
  };
}

function sync(sourceId: string, overrides: Partial<ConnectorSyncDeps> = {}): Promise<ConnectorSyncResult> {
  return runConnectorSync(
    org.adminSql,
    { workspaceId: WS, harness: 'papercusp', sourceIds: [sourceId], pollIntervalSeconds: 300 },
    deps(overrides),
  );
}

/** Run one pass and return the single source outcome. */
async function syncOne(sourceId: string, overrides: Partial<ConnectorSyncDeps> = {}) {
  const result = await sync(sourceId, overrides);
  expect(result.sources).toHaveLength(1);
  return result.sources[0];
}

function mail(nativeId: string, subject = 'Quarterly', extra: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    datatype: 'email-message',
    nativeId,
    event: 'message.received',
    payload: { id: nativeId, from: 'carol@example.com', to: ['alice@example.com'], subject, text: 'Body' },
    occurredAt: OCCURRED_AT,
    ...extra,
  };
}

function page(records: ProviderRecord[], nextCursor: string | null, hasMore: boolean): ProviderSyncPage {
  return { records, nextCursor, hasMore };
}

/** Provider behaviour keyed by the cursor it is asked for (`start` = null). */
function scripted(steps: Record<string, ProviderSyncPage | (() => never)>) {
  return async (req: ProviderSyncRequest): Promise<ProviderSyncPage> => {
    const step = steps[req.cursor ?? 'start'];
    if (!step) throw new Error(`fake provider: unscripted cursor ${req.cursor ?? 'start'}`);
    return typeof step === 'function' ? step() : step;
  };
}

const fail = (cause: unknown) => (): never => {
  throw cause;
};

async function createSource(): Promise<string> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, provider_account_id, status)
    VALUES (${WS}, ${KIND}, ${`acct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'ready')
    RETURNING id::text`;
  return row.id;
}

interface SourceState {
  cursor: string | null;
  backfill_status: string;
  status: string;
  failure_count: number;
  next_in: number | null;
  lease_owner: string | null;
  last_error: string | null;
}

async function state(sourceId: string): Promise<SourceState> {
  const [row] = await org.adminSql<SourceState[]>`
    SELECT cursor->>'provider' AS cursor,
           backfill_status,
           status,
           sync_failure_count AS failure_count,
           EXTRACT(EPOCH FROM sync_next_attempt_at - now())::float8 AS next_in,
           sync_lease_owner AS lease_owner,
           last_error
      FROM harness_shared.data_sources
     WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
  return row;
}

/** Time passes: the source's backoff / poll interval has elapsed. */
async function makeDue(sourceId: string): Promise<void> {
  await org.adminSql`
    UPDATE harness_shared.data_sources SET sync_next_attempt_at = now() - interval '1 second'
     WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
}

/** Ledger rows for a source: one per (dedupe key, sink). */
async function ledger(sourceId: string): Promise<Array<{ dedupe_key: string; sink_kind: string; n: number }>> {
  return org.adminSql<Array<{ dedupe_key: string; sink_kind: string; n: number }>>`
    SELECT dedupe_key, sink_kind, count(*)::int AS n
      FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid
     GROUP BY dedupe_key, sink_kind
     ORDER BY dedupe_key, sink_kind`;
}

async function ledgerKeys(sourceId: string): Promise<string[]> {
  return [...new Set((await ledger(sourceId)).map((row) => row.dedupe_key))].sort();
}

const keysFor = (sourceId: string, records: ProviderRecord[]) =>
  records.map((record) => connectorRecordDedupeKey(sourceId, record)).sort();

/** Exactly-once: no (key, sink) row twice and no key emitted twice. */
async function expectExactlyOnce(sourceId: string): Promise<void> {
  for (const row of await ledger(sourceId)) expect(row.n, `${row.dedupe_key}/${row.sink_kind}`).toBe(1);
  const keys = emitted.filter((key) => key.startsWith(`connector:${sourceId}:`));
  expect(keys.length, 'an event-bus delivery was emitted twice').toBe(new Set(keys).size);
}

async function copyDatatype(id: string): Promise<void> {
  const base = await getDatatype(org.adminSql, 'papercusp-workspace', id);
  if (!base) throw new Error(`connector_runtime_test_datatype_missing:${id}`);
  await upsertDatatype(org.adminSql, {
    id: base.id,
    workspaceId: WS,
    potSlug: base.potSlug,
    title: base.title,
    description: base.description,
    tier: base.tier,
    nature: base.nature,
    audience: base.audience,
    workItemKind: base.workItemKind,
    payloadSchema: base.payloadSchema,
    authoritativeWriter: base.authoritativeWriter,
    selfImprovement: base.selfImprovement,
    published: base.published,
    tags: base.tags,
    createdBy: 'connector-runtime-integration',
  });
}

beforeAll(async () => {
  org = await createOrgTestDb();
  await copyDatatype('email-message');
  registry = createProviderRegistry();
  await registry.register({ descriptor, adapter, pluginName: 'connector-fixture-plugin' });
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(() => {
  handler = async () => page([], null, false);
  calls = [];
  emitted = [];
  crashIngestAfter = null;
  ingestCalls = 0;
});

describe('connector sync driver over registered providers (R-3)', () => {
  it('backfills every page, commits each cursor after admission, then polls incrementally', async () => {
    const src = await createSource();
    const first = [mail('m1'), mail('m2')];
    const second = [mail('m3')];
    handler = scripted({ start: page(first, 'c1', true), c1: page(second, 'c2', false) });

    const outcome = await syncOne(src);
    expect(outcome).toMatchObject({ outcome: 'synced', mode: 'backfill', pages: 2, admitted: 3, deduped: 0 });
    expect(calls).toEqual([
      { cursor: null, mode: 'backfill' },
      { cursor: 'c1', mode: 'backfill' },
    ]);
    const after = await state(src);
    expect(after).toMatchObject({ cursor: 'c2', backfill_status: 'complete', status: 'connected', failure_count: 0, lease_owner: null });
    expect(after.next_in).toBeGreaterThan(200); // the poll interval, not "due now"
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [...first, ...second]));
    await expectExactlyOnce(src);

    // Not due yet: the driver does not touch the provider.
    expect((await sync(src)).sources).toEqual([]);

    await makeDue(src);
    const fourth = [mail('m4')];
    handler = scripted({ c2: page(fourth, 'c3', false) });
    const incremental = await syncOne(src);
    expect(incremental).toMatchObject({ outcome: 'synced', mode: 'incremental', admitted: 1 });
    expect(calls.at(-1)).toEqual({ cursor: 'c2', mode: 'incremental' });
    expect((await state(src)).cursor).toBe('c3');
  });

  it('resolves sinks once per datatype per sync, not once per record (P-011)', async () => {
    const src = await createSource();
    handler = scripted({ start: page([mail('s1'), mail('s2'), mail('s3')], 'c1', false) });
    const resolved: string[] = [];
    const outcome = await syncOne(src, {
      sinksFor: async (_sql, _source, datatype) => {
        resolved.push(datatype);
        return [];
      },
    });
    expect(outcome).toMatchObject({ outcome: 'synced', admitted: 3 });
    // Positive control: three records were admitted, so a per-record resolver would show 3.
    expect(resolved).toEqual(['email-message']);
  });

  it('an interrupted sync resumes from the last committed cursor and delivers each object exactly once', async () => {
    const src = await createSource();
    const first = [mail('m1')];
    const second = [mail('m2'), mail('m3'), mail('m4')];
    handler = scripted({ start: page(first, 'c1', true), c1: page(second, 'c2', false) });

    // The host dies after admitting m1 (page 1, committed) and m2, while admitting m3.
    crashIngestAfter = 2;
    const crashed = await syncOne(src);
    expect(crashed.outcome).toBe('failed');
    expect((await state(src)).cursor).toBe('c1'); // never past the undelivered m3/m4
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [mail('m1'), mail('m2')]));

    // A real crash never ran the failure bookkeeping: leave a lapsed lease behind,
    // as a killed process would, and restart a fresh driver.
    await org.adminSql`
      UPDATE harness_shared.data_sources
         SET sync_lease_owner = 'dead-driver', sync_lease_expires_at = now() - interval '1 second'
       WHERE id = ${src}::uuid`;
    await makeDue(src);
    crashIngestAfter = null;
    const resumed = await syncOne(src, { leaseOwner: 'driver-restarted' });

    expect(resumed).toMatchObject({ outcome: 'synced', pages: 1, admitted: 2, deduped: 1 });
    expect(calls.at(-1)).toEqual({ cursor: 'c1', mode: 'backfill' }); // resumed, not restarted from scratch
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [...first, ...second])); // nothing skipped
    await expectExactlyOnce(src);
    expect(await state(src)).toMatchObject({ cursor: 'c2', backfill_status: 'complete', failure_count: 0, lease_owner: null });
  });

  it('a provider that dies mid-page commits no cursor past undelivered objects', async () => {
    const src = await createSource();
    handler = scripted({
      start: page([mail('m1')], 'c1', true),
      c1: fail(Object.assign(new Error('provider daemon exited'), { code: 'EPIPE' })),
    });
    const died = await syncOne(src);
    expect(died).toMatchObject({ outcome: 'failed', pages: 1, admitted: 1 });
    const afterDeath = await state(src);
    expect(afterDeath).toMatchObject({ cursor: 'c1', failure_count: 1, lease_owner: null });
    expect(afterDeath.next_in).toBeGreaterThan(20); // backed off
    expect(afterDeath.next_in).toBeLessThanOrEqual(30);

    // A half-written page (a record outside the descriptor's datatypes) is refused whole:
    // its valid record is not admitted and the cursor does not move.
    await makeDue(src);
    handler = scripted({
      c1: page([mail('m2'), { ...mail('bad'), datatype: 'calendar-event' }], 'c2', false),
    });
    expect((await syncOne(src)).outcome).toBe('failed');
    expect((await state(src)).cursor).toBe('c1');
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [mail('m1')]));

    await makeDue(src);
    handler = scripted({ c1: page([mail('m2')], 'c2', false) });
    const recovered = await syncOne(src);
    expect(recovered).toMatchObject({ outcome: 'synced', admitted: 1 });
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [mail('m1'), mail('m2')]));
    expect(await state(src)).toMatchObject({ cursor: 'c2', failure_count: 0, status: 'connected' });
    await expectExactlyOnce(src);
  });

  it('repeated failures back off exponentially and degrade the source health', async () => {
    const src = await createSource();
    handler = fail(new Error('upstream 503'));
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) await makeDue(src);
      expect((await syncOne(src)).outcome).toBe('failed');
      const s = await state(src);
      expect(s.failure_count).toBe(attempt);
      waits.push(Math.round(s.next_in ?? 0));
    }
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(waits[2]).toBeGreaterThan(waits[1]);
    expect((await state(src)).status).toBe('degraded');

    await makeDue(src);
    handler = scripted({ start: page([mail('m1')], 'c1', false) });
    expect((await syncOne(src)).outcome).toBe('synced');
    expect(await state(src)).toMatchObject({ status: 'connected', failure_count: 0, last_error: null });
  });

  it('an expired cursor resets to a fresh backfill once, and the replayed objects dedupe', async () => {
    const src = await createSource();
    const mailbox = [mail('m1'), mail('m2')];
    handler = scripted({ start: page(mailbox, 'c1', false) });
    await syncOne(src);

    await makeDue(src);
    handler = scripted({
      c1: fail(new ProviderSyncFailure({ kind: 'cursor-expired', message: 'history id too old' })),
      start: page(mailbox, 'c2', false),
    });
    const reset = await syncOne(src);
    expect(reset).toMatchObject({ outcome: 'synced', cursorReset: true, mode: 'backfill', admitted: 0, deduped: 2 });
    // WI-10001662 port: a full resync names the provider's reason, on the outcome and the log line.
    expect(reset.cursorResetReason).toBe('history id too old');
    expect(formatConnectorSyncLog({ providers: 1, sources: [reset] })).toContain(
      `cursor_resets=1 reset_reasons=${src}: history id too old`,
    );
    expect(calls.slice(-2)).toEqual([
      { cursor: 'c1', mode: 'incremental' },
      { cursor: null, mode: 'backfill' },
    ]);
    expect(await state(src)).toMatchObject({ cursor: 'c2', backfill_status: 'complete' });
    await expectExactlyOnce(src);

    // A provider that rejects the fresh cursor too is a failure, never a reset loop.
    await makeDue(src);
    const expired = fail(new ProviderSyncFailure({ kind: 'cursor-expired', message: 'still expired' }));
    handler = scripted({ c2: expired, start: expired });
    const callsBefore = calls.length;
    expect((await syncOne(src)).outcome).toBe('failed');
    expect(calls.length - callsBefore).toBe(2);
  });

  it('duplicate pages dedupe against the ledger (with a positive control for the counter)', async () => {
    const src = await createSource();
    handler = scripted({
      start: page([mail('m1'), mail('m2')], 'c1', true),
      c1: page([mail('m2'), mail('m3')], 'c2', false), // m2 repeated across pages
    });
    const outcome = await syncOne(src);
    expect(outcome).toMatchObject({ admitted: 3, deduped: 1 });
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [mail('m1'), mail('m2'), mail('m3')]));
    await expectExactlyOnce(src);
    const emittedBefore = emitted.length;

    // Positive control: a driver that did NOT derive a replay-stable key would admit the
    // same object again. The same counters must see that second delivery, so the
    // exactly-once assertions above are not vacuous.
    await ingest(org.adminSql, {
      workspaceId: WS,
      sourceId: src,
      source: KIND,
      event: 'message.received',
      externalId: 'm2',
      datatypeId: 'email-message',
      adapterPayload: mail('m2').payload,
      normalize: (payload) => payload as Record<string, unknown>,
      occurredAt: OCCURRED_AT,
      dedupeKey: `connector:${src}:email-message:m2:unstable-${Date.now()}`,
    });
    expect(emitted.length).toBe(emittedBefore + 1);
    expect((await ledgerKeys(src)).length).toBe(4);
    await expect(expectExactlyOnce(src)).resolves.toBeUndefined(); // distinct keys, so still one row each
    expect(emitted.filter((key) => key.includes(':email-message:m2:')).length).toBe(2);
  });

  it('edits and deletes of an existing object are new deliveries; a replayed delete is not', async () => {
    const src = await createSource();
    const original = mail('m1', 'v1');
    const edited = mail('m1', 'v2');
    const deleted = mail('m1', 'v2', { event: 'message.deleted', deleted: true });
    handler = scripted({
      start: page([original], 'c1', false),
      c1: page([edited], 'c2', false),
      c2: page([deleted], 'c3', false),
      c3: page([deleted], 'c4', false),
    });

    expect((await syncOne(src)).admitted).toBe(1);
    await makeDue(src);
    expect((await syncOne(src)).admitted).toBe(1); // edit
    await makeDue(src);
    expect((await syncOne(src)).admitted).toBe(1); // delete
    await makeDue(src);
    expect(await syncOne(src)).toMatchObject({ admitted: 0, deduped: 1 }); // delete replayed

    expect(await ledgerKeys(src)).toEqual(keysFor(src, [original, edited, deleted]));
    await expectExactlyOnce(src);
  });

  it('a 429 keeps the committed cursor and waits out retry-after; a push wake does not override it', async () => {
    const src = await createSource();
    handler = scripted({
      start: page([mail('m1')], 'c1', true),
      c1: fail(new ProviderSyncFailure({ kind: 'rate-limited', retryAfterSeconds: 120, message: '429 Too Many Requests' })),
    });
    const limited = await syncOne(src);
    expect(limited).toMatchObject({ outcome: 'rate-limited', admitted: 1 });
    const s = await state(src);
    expect(s).toMatchObject({ cursor: 'c1', status: 'connected', failure_count: 1, lease_owner: null });
    expect(s.next_in).toBeGreaterThan(100);
    expect(s.next_in).toBeLessThanOrEqual(120);

    const callsBefore = calls.length;
    expect((await sync(src)).sources).toEqual([]); // still cooling down
    expect(await wakeConnectorSource(org.adminSql, { workspaceId: WS, sourceId: src })).toBe(true);
    expect((await sync(src)).sources).toEqual([]); // the wake never overrides a backoff
    expect(calls.length).toBe(callsBefore);

    // A JSON-RPC shaped error from a daemon provider classifies the same way.
    await makeDue(src);
    handler = scripted({
      c1: fail({ code: -32000, message: 'provider error', data: { kind: 'rate-limited', retryAfterSeconds: 60 } }),
    });
    expect((await syncOne(src)).outcome).toBe('rate-limited');
    const again = await state(src);
    expect(again.cursor).toBe('c1');
    expect(again.next_in).toBeGreaterThan(40);
    expect(again.next_in).toBeLessThanOrEqual(60);

    await makeDue(src);
    handler = scripted({ c1: page([mail('m2')], 'c2', false) });
    expect(await syncOne(src)).toMatchObject({ outcome: 'synced', admitted: 1 });
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [mail('m1'), mail('m2')]));
  });

  it('a push wake makes a healthy source due immediately', async () => {
    const src = await createSource();
    handler = scripted({ start: page([mail('m1')], 'c1', false), c1: page([mail('m2')], 'c2', false) });
    await syncOne(src);
    expect((await sync(src)).sources).toEqual([]); // polled recently

    expect(await wakeConnectorSource(org.adminSql, { workspaceId: WS, sourceId: src })).toBe(true);
    expect(await syncOne(src)).toMatchObject({ outcome: 'synced', mode: 'incremental', admitted: 1 });
  });

  it('skips a source whose lease another live driver holds, and takes over a lapsed one', async () => {
    const src = await createSource();
    handler = scripted({ start: page([mail('m1')], 'c1', false) });
    await org.adminSql`
      UPDATE harness_shared.data_sources
         SET sync_lease_owner = 'driver-b', sync_lease_expires_at = now() + interval '5 minutes'
       WHERE id = ${src}::uuid`;
    expect((await syncOne(src)).outcome).toBe('leased-elsewhere');
    expect(calls).toEqual([]);
    expect(await ledger(src)).toEqual([]);
    expect((await state(src)).lease_owner).toBe('driver-b');

    await org.adminSql`
      UPDATE harness_shared.data_sources SET sync_lease_expires_at = now() - interval '1 second'
       WHERE id = ${src}::uuid`;
    expect((await syncOne(src)).outcome).toBe('synced');
    expect((await state(src)).lease_owner).toBeNull();
  });

  it('an auth failure marks the source reconnect-required and stops syncing it', async () => {
    const src = await createSource();
    handler = fail(new ProviderSyncFailure({ kind: 'auth', message: 'invalid_grant' }));
    expect(await syncOne(src)).toMatchObject({ outcome: 'reconnect-required', error: 'invalid_grant' });
    const s = await state(src);
    expect(s.status).toBe('error');
    expect(s.last_error).toMatch(/^reconnect_required: invalid_grant/);
    await makeDue(src);
    expect((await sync(src)).sources).toEqual([]);
  });
});

/**
 * D-020: a provider declaring `sync.adopt` starts a source a retired host path drove from that
 * path's freshest cursor, instead of null (a full re-walk under new delivery keys).
 */
describe('sync.adopt: adopting a pre-provider cursor (D-020)', () => {
  let adoptRegistry: ProviderRegistry;
  let adoptCalls: Array<Record<string, unknown>>;
  let adoptAnswer: () => unknown;

  const adoptingAdapter: ProviderAdapter = {
    describe: () => ({ ...descriptor, capabilities: ['mail.read', 'sync.adopt'] }),
    syncPage: adapter.syncPage,
    invoke: async (req) => {
      if (req.capability !== 'sync.adopt') throw new Error(`unexpected capability ${req.capability}`);
      adoptCalls.push((req.args as { prior: Record<string, unknown> }).prior);
      return adoptAnswer();
    },
  };

  async function setCursor(sourceId: string, cursor: Record<string, unknown>): Promise<void> {
    await org.adminSql`
      UPDATE harness_shared.data_sources SET cursor = ${org.adminSql.json(cursor as never)}::jsonb
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
  }

  async function hasProviderKey(sourceId: string): Promise<boolean> {
    const [row] = await org.adminSql<{ has: boolean }[]>`
      SELECT cursor ? 'provider' AS has FROM harness_shared.data_sources
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    return row.has;
  }

  const adoptSync = (sourceId: string) => syncOne(sourceId, { registry: adoptRegistry });

  beforeAll(async () => {
    adoptRegistry = createProviderRegistry();
    await adoptRegistry.register({
      descriptor: { ...descriptor, capabilities: ['mail.read', 'sync.adopt'] },
      adapter: adoptingAdapter,
      pluginName: 'connector-fixture-adopting-plugin',
    });
  });

  beforeEach(() => {
    adoptCalls = [];
    adoptAnswer = () => ({ cursor: null, backfillComplete: false });
  });

  it('adopts the legacy position once, without the host-owned wake key, and syncs incrementally from it', async () => {
    const src = await createSource();
    await setCursor(src, { historyId: '500', emailAddress: 'a@example.com', wake: 'wake-state' });
    adoptAnswer = () => ({ cursor: 'adopted-500', backfillComplete: true });
    handler = scripted({ 'adopted-500': page([mail('m1')], 'c1', false) });

    const first = await adoptSync(src);
    expect(first).toMatchObject({ outcome: 'synced', adopted: true, mode: 'incremental', admitted: 1 });
    expect(adoptCalls).toEqual([{ historyId: '500', emailAddress: 'a@example.com' }]);
    expect(calls).toEqual([{ cursor: 'adopted-500', mode: 'incremental' }]);
    expect(await state(src)).toMatchObject({ cursor: 'c1', backfill_status: 'complete' });

    // The provider now owns the cursor: no second adoption.
    await makeDue(src);
    handler = scripted({ c1: page([], 'c2', false) });
    const second = await adoptSync(src);
    expect(second.adopted).toBeUndefined();
    expect(adoptCalls).toHaveLength(1);
    expect(calls.at(-1)).toEqual({ cursor: 'c1', mode: 'incremental' });
  });

  it('an adopted position that still owes a backfill syncs in backfill mode', async () => {
    const src = await createSource();
    await setCursor(src, { historyId: '700', backfill: { status: 'pending', pageToken: 'p9' } });
    adoptAnswer = () => ({ cursor: 'adopted-700', backfillComplete: false });
    handler = scripted({ 'adopted-700': page([mail('m1')], 'b1', true), b1: page([], 'b2', false) });
    const outcome = await adoptSync(src);
    expect(outcome).toMatchObject({ outcome: 'synced', adopted: true, mode: 'backfill' });
    expect(calls).toEqual([
      { cursor: 'adopted-700', mode: 'backfill' },
      { cursor: 'b1', mode: 'backfill' },
    ]);
    expect(await state(src)).toMatchObject({ cursor: 'b2', backfill_status: 'complete' });
  });

  it('never re-adopts once the provider key exists, even when a cursor-expired reset nulled it', async () => {
    const src = await createSource();
    await setCursor(src, { provider: null, historyId: '900' });
    const outcome = await adoptSync(src);
    expect(outcome.outcome).toBe('synced');
    expect(adoptCalls).toEqual([]);
    expect(calls).toEqual([{ cursor: null, mode: 'backfill' }]);
  });

  it('a provider with nothing to adopt starts fresh, and a source with no prior state is never asked', async () => {
    const src = await createSource();
    await setCursor(src, { lastSyncAt: '2026-09-01T00:00:00Z' });
    expect((await adoptSync(src)).adopted).toBeUndefined();
    expect(adoptCalls).toHaveLength(1);
    expect(calls).toEqual([{ cursor: null, mode: 'backfill' }]);

    const fresh = await createSource();
    await adoptSync(fresh);
    expect(adoptCalls).toHaveLength(1);
  });

  it('an adopt failure fails the pass and writes no cursor, rather than falling back to a null start', async () => {
    const src = await createSource();
    await setCursor(src, { historyId: '1200' });
    adoptAnswer = () => {
      throw new Error('adopt exploded');
    };
    const failed = await adoptSync(src);
    expect(failed).toMatchObject({ outcome: 'failed' });
    expect(calls).toEqual([]);
    expect(await hasProviderKey(src)).toBe(false);
    expect((await state(src)).failure_count).toBe(1);

    // A malformed answer is a failure too.
    await makeDue(src);
    adoptAnswer = () => ({ cursor: 42, backfillComplete: true });
    expect((await adoptSync(src)).outcome).toBe('failed');
    expect(await hasProviderKey(src)).toBe(false);
  });
});
