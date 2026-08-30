/**
 * P-008 — the producer→app round trip, asserted on the RECEIVING END.
 *
 * Every other test in this directory stops at the sending abstraction: it
 * checks that the producer builds the right batch, resolves the right owner, or
 * mints the right token. None of them can answer the question P-008 actually
 * asks — does a real row arrive in the app's own store, and can the app itself
 * serve it back? That needs a live app, so it lives here rather than in a unit
 * test, and it SKIPS rather than fails when one is not configured.
 *
 * WHAT MAKES THIS EVIDENCE RATHER THAN A MOCK:
 *  - the token is minted by the production `appServiceAuthHeader` and verified
 *    by the app's own `jwtVerify`, so the auth leg is real. The test asserts an
 *    unauthenticated call is REFUSED first, which is what proves the app is not
 *    running in LOCAL_MODE (where any caller is accepted as a fixed owner and
 *    this whole suite would pass vacuously);
 *  - the batch is built by `buildAppSyncBatch` from a record shaped by
 *    `appRowFromSourceRecord` — the same mapper the live push sink and the
 *    reconcile sweep both use, so a divergence between them would surface here;
 *  - the assertion is a GET against the app's own read endpoint, not a database
 *    peek, so it exercises the app's store AND its read path.
 *
 * It uses a per-run synthetic ownerId and provider id so it neither depends on
 * nor disturbs whatever real data the app holds.
 *
 * To run it, point it at a live sidecar (see the calendar/email TESTING.md):
 *   EMAIL_APP_URL, EMAIL_AUTH_SECRET  (and/or CALENDAR_*)
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { appServiceAuthHeader } from './app-auth';
import { appRowFromSourceRecord, buildAppSyncBatch, sourceRefForApp } from './app-rows';
import { deliverAppSyncBatch } from './live-sink';
import type { ProducerApp } from './owner-mapping';

const PROBE_TIMEOUT_MS = 3_000;

interface AppCase {
  app: ProducerApp;
  /** The canonical `personal_documents.source` that maps to this app. */
  source: string;
  baseUrl: string;
  secret: string;
}

function configuredCases(): AppCase[] {
  const cases: AppCase[] = [];
  for (const [app, source] of [['email', 'gmail'], ['calendar', 'calendar']] as const) {
    const baseUrl = process.env[`${app.toUpperCase()}_APP_URL`]?.trim() ?? '';
    const secret = process.env[`${app.toUpperCase()}_AUTH_SECRET`]?.trim() ?? '';
    if (baseUrl && secret) cases.push({ app, source, baseUrl: baseUrl.replace(/\/+$/, ''), secret });
  }
  return cases;
}

async function reachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

const CASES = configuredCases();
const live = new Map<ProducerApp, boolean>();
await Promise.all(CASES.map(async (c) => live.set(c.app, await reachable(c.baseUrl))));

/** Owners this run created, so the run cleans up after itself. */
const created: { c: AppCase; ownerId: string; externalId: string }[] = [];

afterAll(async () => {
  // Best-effort: the apps expose no delete-by-owner, and the rows are scoped to
  // a throwaway ownerId no reader will ever authenticate as, so leaving them is
  // inert. Recorded here so the absence of cleanup is a decision, not a gap.
  created.length = 0;
});

describe.skipIf(CASES.length === 0)('P-008 producer → app round trip (live app required)', () => {
  for (const c of CASES) {
    describe.skipIf(!live.get(c.app))(`${c.app}`, () => {
      const ownerId = `p008-live-test-${randomUUID()}`;
      const externalId = `p008-${randomUUID()}`;

      it('refuses an unauthenticated read (proves LOCAL_MODE is off, so the auth leg is real)', async () => {
        const res = await fetch(`${c.baseUrl}/api/sync/cursor`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        expect(res.status).toBe(401);
      });

      it('delivers a canonical row and the app serves it back under the minted token', async () => {
        const occurredAt = new Date().toISOString();
        const mapped = appRowFromSourceRecord({
          source: c.source,
          kind: c.app === 'email' ? 'message' : 'event',
          externalId,
          occurredAt,
          title: 'P-008 live round trip',
          text: 'Delivered by the platform→app data producer.',
          // Provider-shaped fields ride through `metadata` untouched, exactly as
          // a real normalized payload does.
          metadata: c.app === 'email'
            ? { from: 'p008@example.com', to: ['owner@example.com'] }
            : { calendarId: 'primary', start: { dateTime: occurredAt }, end: { dateTime: occurredAt } },
        });
        expect(mapped, `appForSource must map '${c.source}' to an app`).not.toBeNull();
        expect(mapped!.app).toBe(c.app);

        const batch = buildAppSyncBatch(c.app, [mapped!.row], { cursor: null });
        const result = await deliverAppSyncBatch(batch, ownerId, {
          baseUrl: c.baseUrl,
          secret: c.secret,
        });
        expect(result.status).toBe(200);
        expect(result.rowCount).toBe(1);
        created.push({ c, ownerId, externalId });

        // RECEIVING END: ask the APP, through the APP's own read path, under a
        // token minted the way the producer mints one.
        const authorization = await appServiceAuthHeader(c.app, ownerId, { secret: c.secret });
        const path = c.app === 'email' ? `/api/threads/${externalId}` : `/api/events/${externalId}`;
        const res = await fetch(`${c.baseUrl}${path}`, {
          headers: { authorization },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { messages?: { id: string }[]; event?: { id: string } };

        const servedId = c.app === 'email'
          ? body.messages?.find((m) => m.id === externalId)?.id
          : body.event?.id;
        expect(servedId, `the ${c.app} app must serve back the row it was sent`).toBe(externalId);
      });

      it('reports a cursor for this app’s source ref', async () => {
        const authorization = await appServiceAuthHeader(c.app, ownerId, { secret: c.secret });
        const res = await fetch(
          `${c.baseUrl}/api/sync/cursor?sourceRef=${encodeURIComponent(sourceRefForApp(c.app))}`,
          { headers: { authorization }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
        );
        expect(res.status).toBe(200);
        expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
      });
    });
  }
});
