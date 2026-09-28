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
import { syncGoogleGmailSource } from '../external-triggers/google-gmail';
import { syncGoogleCalendarSource } from '../external-triggers/google-calendar';
import type { ExternalTriggerSourceRow } from '../external-triggers/source-store';
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

function gmailFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/history')) {
      // Every real Gmail history record carries an `id`; the incremental sync keys its
      // idempotent resume on it and refuses a record without one.
      return json({ history: [{ id: 'h-1', messagesAdded: [{ message: { id: 'm-1' } }] }], historyId: '99' });
    }
    if (url.includes('/messages/m-1')) {
      return json({
        id: 'm-1',
        threadId: 't-1',
        internalDate: String(NOW.getTime()),
        payload: { headers: [{ name: 'Subject', value: 'Hello' }], body: { data: '' } },
      });
    }
    return json({ emailAddress: 'owner@example.com', historyId: '99' });
  }) as typeof fetch;
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
  it('registers the app sink alongside the personal vault on the Gmail path', async () => {
    const deps = captureDeps(gmailFetch(), fakeAppSink());
    await syncGoogleGmailSource({} as unknown as Sql, source('gmail', { historyId: '10' }), 'token', deps.value);

    expect(deps.sinkKindsPerEvent.length).toBeGreaterThan(0);
    // Every ingested event carries BOTH sinks — not just the first.
    for (const kinds of deps.sinkKindsPerEvent) {
      expect(kinds).toContain('personal-vault');
      expect(kinds).toContain('app-delivery');
    }
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
    const deps = captureDeps(gmailFetch(), null);
    await syncGoogleGmailSource({} as unknown as Sql, source('gmail', { historyId: '10' }), 'token', deps.value);

    expect(deps.sinkKindsPerEvent.length).toBeGreaterThan(0);
    for (const kinds of deps.sinkKindsPerEvent) {
      expect(kinds).toContain('personal-vault');
      // The whole point of self-gating: an unconfigured install produces no
      // app-delivery row at all, rather than a row that fails on every event.
      expect(kinds).not.toContain('app-delivery');
    }
  });

  it('resolves the app sink ONCE per sync, not once per event', async () => {
    const deps = captureDeps(gmailFetch(), fakeAppSink());
    await syncGoogleGmailSource({} as unknown as Sql, source('gmail', { historyId: '10' }), 'token', deps.value);
    expect(deps.value.createAppSink).toHaveBeenCalledTimes(1);
  });
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

  it('does not abort a Gmail sync when the real gate cannot reach the database, and REPORTS the decline (P-007)', async () => {
    // No createAppSink override: this exercises the DEFAULT production path
    // against an unusable sql handle, which is what a database fault looks like.
    //
    // P-007 added the second half of this assertion. Surviving the fault was
    // never enough: the gate swallows its own error to protect the sync, so
    // before the adapters passed `onGateError` this sync was indistinguishable
    // from one where no mapping was configured — the user's app silently stopped
    // receiving mail and nothing anywhere said why.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = captureDeps(gmailFetch(), null);
      const { createAppSink: _omitted, ...withRealGate } = deps.value;

      const result = await syncGoogleGmailSource(
        {} as unknown as Sql,
        source('gmail', { historyId: '10' }),
        'token',
        withRealGate,
      );

      expect(result.messages).toBeGreaterThan(0);
      for (const kinds of deps.sinkKindsPerEvent) {
        expect(kinds).toContain('personal-vault');
        expect(kinds).not.toContain('app-delivery');
      }

      // Registration is resolved once per sync, so exactly one report.
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
