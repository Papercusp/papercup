/**
 * P-011 — the sink is REGISTERED, not merely constructible.
 *
 * app-rows.test.ts already proves the mapper and live-sink.ts proves delivery.
 * Neither notices the failure this file exists to catch: modules that are
 * correct, tested, and wired into nothing, so no data is ever pushed. Every
 * assertion here is about the seam between the adapters and the sink.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { syncGoogleCalendarSource } from '../external-triggers/google-calendar';
import type { ExternalTriggerSourceRow } from '../external-triggers/source-store';
import { connectorSinksFor, type ConnectorSourceRow } from '../providers/connector-runtime';
import { createAppDeliverySinkIfConfigured } from './live-sink';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const WORKSPACE = 'papercusp-workspace';
const USER = '22222222-2222-4222-8222-222222222222';
const SOURCE_ID = '11111111-1111-4111-8111-111111111111';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function source(kind: 'gmail' | 'gcal', cursor: Record<string, unknown> = {}): ExternalTriggerSourceRow {
  return {
    id: SOURCE_ID,
    workspaceId: WORKSPACE,
    kind,
    ownerUserId: USER,
    credentialRef: 'google-workspace:owner',
    providerAccountId: 'owner@example.com',
    status: 'connected',
    config: {},
    cursor,
  };
}

/** A stand-in app-delivery sink; identity is all these assertions need. */
function fakeAppSink() {
  return {
    kind: 'app-delivery' as const,
    ref: `user:${USER}:source:${SOURCE_ID}`,
    deliver: async () => undefined,
  };
}

/**
 * Captures what each adapter hands to ingestion. `additionalSinks` is the only
 * thing under test: it is the list the ingestion loop actually iterates.
 */
function captureDeps(fetchImpl: typeof fetch, appSink: ReturnType<typeof fakeAppSink> | null) {
  const sinkKindsPerEvent: string[][] = [];
  return {
    sinkKindsPerEvent,
    createAppSink: vi.fn(async () => appSink),
    value: {
      fetch: fetchImpl,
      now: () => NOW,
      createPersonalSink: vi.fn(async () => ({
        kind: 'personal-vault' as const,
        ref: `user:${USER}`,
        deliver: async () => undefined,
      })),
      createAppSink: vi.fn(async () => appSink),
      ingest: vi.fn(async (_sql: unknown, input: { additionalSinks?: { kind: string }[] }) => {
        sinkKindsPerEvent.push((input.additionalSinks ?? []).map((s) => s.kind));
        return { ok: true, event: {} as never, deliveries: [] };
      }),
      updateSource: vi.fn(async () => source('gmail')),
    },
  };
}

/**
 * A provider connector source (Gmail is a registered provider, P-008). Mail sync
 * runs through the shared connector runtime, so its sink registration is
 * `connectorSinksFor` — the list the runtime hands ingestion as `additionalSinks`.
 */
function connectorSource(ownerUserId: string | null = USER): ConnectorSourceRow {
  return {
    id: SOURCE_ID,
    workspaceId: WORKSPACE,
    kind: 'gmail',
    ownerUserId,
    credentialRef: 'google-workspace:owner',
    status: 'connected',
    config: {},
    cursor: {},
    backfillStatus: 'complete',
    failureCount: 0,
    wakeRequestedAt: null,
  };
}

function connectorSeams(appSink: ReturnType<typeof fakeAppSink> | null) {
  return {
    createPersonalSink: vi.fn(async () => ({
      kind: 'personal-vault' as const,
      ref: `user:${USER}`,
      deliver: async () => undefined,
    })),
    createDatatypeSinks: vi.fn(async () => []),
    createAppSink: vi.fn(async () => appSink),
  };
}

function calendarFetch(): typeof fetch {
  return (async () =>
    json({
      items: [
        {
          id: 'e-1',
          status: 'confirmed',
          summary: 'Standup',
          created: NOW.toISOString(),
          updated: NOW.toISOString(),
          start: { dateTime: '2026-09-01T12:00:00.000Z' },
          end: { dateTime: '2026-09-01T12:30:00.000Z' },
        },
      ],
      nextSyncToken: 'tok-2',
    })) as typeof fetch;
}

describe('P-011 app-delivery sink registration', () => {
  it('registers the app sink alongside the personal vault on the provider (mail) path', async () => {
    const seams = connectorSeams(fakeAppSink());
    const sinks = await connectorSinksFor({} as unknown as Sql, connectorSource(), 'email-message', seams);

    expect(sinks.map((s) => s.kind)).toEqual(['personal-vault', 'app-delivery']);
    expect(seams.createAppSink).toHaveBeenCalledWith(expect.anything(), WORKSPACE, SOURCE_ID, 'email');
  });

  it('registers no app sink for a datatype no app consumes, and none for an unowned source', async () => {
    const seams = connectorSeams(fakeAppSink());
    await connectorSinksFor({} as unknown as Sql, connectorSource(), 'ticket-issue', seams);
    const unowned = await connectorSinksFor({} as unknown as Sql, connectorSource(null), 'email-message', seams);

    expect(seams.createAppSink).not.toHaveBeenCalled();
    expect(unowned.map((s) => s.kind)).not.toContain('app-delivery');
  });

  it('registers the app sink alongside the personal vault on the Calendar path', async () => {
    const deps = captureDeps(calendarFetch(), fakeAppSink());
    await syncGoogleCalendarSource(
      {} as unknown as Sql,
      source('gcal', { syncToken: 'tok-1' }),
      'access-token',
      {},
      deps.value,
    );

    expect(deps.sinkKindsPerEvent.length).toBeGreaterThan(0);
    for (const kinds of deps.sinkKindsPerEvent) {
      expect(kinds).toContain('personal-vault');
      expect(kinds).toContain('app-delivery');
    }
  });

  it('registers NO app sink when the deployment has no owner mapping', async () => {
    const sinks = await connectorSinksFor({} as unknown as Sql, connectorSource(), 'email-message', connectorSeams(null));

    // The whole point of self-gating: an unconfigured install produces no
    // app-delivery row at all, rather than a row that fails on every event.
    expect(sinks.map((s) => s.kind)).toEqual(['personal-vault']);
  });

  // "Once per sync, not once per event" is a property of the connector loop's
  // per-datatype sink cache: connector-runtime.integration.test.ts asserts it.
});

describe('P-011 registration is isolated from the rest of the sync', () => {
  /**
   * The load-bearing property. At DELIVER time the ingestion loop already
   * isolates each sink. REGISTRATION runs outside that loop, so an exception
   * here would abort the vault write too — costing the user their ingestion
   * because of a problem in a downstream app's mapping.
   */
  it('declines instead of throwing when the mapping lookup fails', async () => {
    const exploding = (() => {
      throw new Error('connection terminated unexpectedly');
    }) as unknown as Sql;
    const onGateError = vi.fn();

    await expect(
      createAppDeliverySinkIfConfigured(exploding, WORKSPACE, SOURCE_ID, 'email', { onGateError }),
    ).resolves.toBeNull();
    expect(onGateError).toHaveBeenCalledTimes(1);
  });

  it('does not abort mail sink registration when the real gate cannot reach the database, and REPORTS the decline (P-007)', async () => {
    // No createAppSink seam: this exercises the DEFAULT production gate against
    // an unusable sql handle, which is what a database fault looks like.
    //
    // P-007 added the second half of this assertion. Surviving the fault was
    // never enough: the gate swallows its own error to protect the sync, so
    // before the adapters passed `onGateError` this sync was indistinguishable
    // from one where no mapping was configured — the user's app silently stopped
    // receiving mail and nothing anywhere said why. The provider connector path
    // lost this once (P-008 found it); this assertion is what holds it.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { createAppSink: _omitted, ...withRealGate } = connectorSeams(null);

      const sinks = await connectorSinksFor({} as unknown as Sql, connectorSource(), 'email-message', withRealGate);

      expect(sinks.map((s) => s.kind)).toEqual(['personal-vault']);

      // Exactly one report for the one app consuming this datatype.
      expect(errors).toHaveBeenCalledTimes(1);
      const line = String(errors.mock.calls[0]![0]);
      // The prefix is the interface `logs:read { grep }` matches on.
      expect(line).toContain('[app-data-producer] SINK REGISTRATION DECLINED');
      expect(line).toContain('app=email');
      expect(line).toContain(SOURCE_ID);
    } finally {
      errors.mockRestore();
    }
  });

  it('reports the decline on the CALENDAR path too — the wiring is per-adapter and can drift', async () => {
    // `onGateError` is passed at each adapter's own registration site, so
    // asserting it on Gmail alone would let Calendar lose it silently. Both
    // adapters route through the shared `reportAppSinkGateError`, and this is
    // what holds that symmetry.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = captureDeps(calendarFetch(), null);
      const { createAppSink: _omitted, ...withRealGate } = deps.value;

      const result = await syncGoogleCalendarSource(
        {} as unknown as Sql,
        source('gcal', { syncToken: 'tok-1' }),
        'access-token',
        {},
        withRealGate,
      );

      // The sync completed rather than aborting on the gate fault.
      expect(result.created + result.updated).toBeGreaterThan(0);
      expect(deps.sinkKindsPerEvent.length).toBeGreaterThan(0);
      for (const kinds of deps.sinkKindsPerEvent) {
        expect(kinds).toContain('personal-vault');
        expect(kinds).not.toContain('app-delivery');
      }

      expect(errors).toHaveBeenCalledTimes(1);
      const line = String(errors.mock.calls[0]![0]);
      expect(line).toContain('[app-data-producer] SINK REGISTRATION DECLINED');
      expect(line).toContain('app=calendar');
    } finally {
      errors.mockRestore();
    }
  });
});
