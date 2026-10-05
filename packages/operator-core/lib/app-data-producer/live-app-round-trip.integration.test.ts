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
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { appServiceAuthHeader } from './app-auth';
import { appRowFromSourceRecord, appRowId, buildAppSyncBatch, DATATYPE_FOR_APP, sourceRefForApp } from './app-rows';
import type { ProducerSourceRecord } from './app-rows';
import { deliverAppSyncBatch } from './live-sink';
import type { ProducerApp } from './owner-mapping';

const PROBE_TIMEOUT_MS = 3_000;

interface AppCase {
  app: ProducerApp;
  /** The canonical `documents.source` that maps to this app. */
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
          datatypeId: DATATYPE_FOR_APP[c.app],
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
        expect(mapped, `the ${c.app} datatype must map to an app`).not.toBeNull();
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

      // ── P-012: the app's judgment door is de-conflated, proven on the LIVE app ──
      // `handleGmailTrigger` keeps `ingestCanonicalMessage` and no longer calls
      // `seam.enqueueWorkItems`, so platform binding b7976842 stays the single
      // judgment path. Its observable contract is exactly two facts: the content
      // still lands, and `workItemIds` comes back EMPTY. The Email app repo's own
      // unit test asserts that in-process; this asserts it against the DEPLOYED
      // sidecar, which is the half that can rot without anyone noticing — and it
      // is the only evidence for P-012 that resolves inside this repository.
      if (c.app === 'email') {
        const triggerExternalId = `p012-${randomUUID()}`;

        it('ingests a Gmail trigger and mints ZERO work items (P-012 de-conflation)', async () => {
          const occurredAt = new Date().toISOString();
          const mapped = appRowFromSourceRecord({
            source: c.source,
            datatypeId: DATATYPE_FOR_APP[c.app],
            kind: 'message',
            externalId: triggerExternalId,
            occurredAt,
            title: 'P-012 judgment-door de-conflation',
            text: 'Posted straight at the app trigger door; must mint no work item.',
            metadata: { from: 'p012@example.com', to: ['owner@example.com'] },
          });
          expect(mapped, `the ${c.app} datatype must map to an app`).not.toBeNull();

          const authorization = await appServiceAuthHeader(c.app, ownerId, { secret: c.secret });
          const res = await fetch(`${c.baseUrl}/api/triggers/gmail`, {
            method: 'POST',
            headers: { authorization, 'content-type': 'application/json' },
            body: JSON.stringify({
              eventKey: 'ext:gmail:message.received',
              dedupeKey: triggerExternalId,
              payload: mapped!.row,
            }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            ok: boolean;
            deduplicated: boolean;
            workItemIds: string[];
            messageId?: string;
          };
          expect(body.ok).toBe(true);
          expect(body.deduplicated).toBe(false);
          // THE ASSERTION THIS TEST EXISTS FOR.
          expect(body.workItemIds).toEqual([]);
          // …and the content half still landed, so an empty list means the judgment
          // half was REMOVED rather than the whole handler having been switched off.
          // Without this second assertion a fully broken endpoint would also pass.
          expect(body.messageId).toBe(triggerExternalId);

          const served = await fetch(`${c.baseUrl}/api/threads/${triggerExternalId}`, {
            headers: { authorization },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          expect(served.status).toBe(200);
          const thread = (await served.json()) as { messages?: { id: string }[] };
          expect(
            thread.messages?.some((m) => m.id === triggerExternalId),
            'the app must serve back the message its trigger door ingested',
          ).toBe(true);
        });
      }

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

// ── WI-933686 — the same round trip, on REAL GOOGLE DATA ────────────────────
//
// WHY THIS EXISTS SEPARATELY FROM THE BLOCK ABOVE.
// That block is deliberately non-disturbing: its header says it uses "a per-run
// synthetic ownerId and provider id". That makes the AUTH leg, the DELIVERY leg
// and the APP real — but the DATA fake, and the fake data is precisely the gap
// WI-933686 was filed for. Acceptance scorecard EI-21832584701743975 rated
// `web-apps-real-data` only partially-met because both apps' real-data claim
// rested on the platform delivery ledger and on manual driving, rather than on
// an executing assertion. This block is that assertion.
//
// It changes exactly ONE variable: the record is READ FROM the live
// `documents` vault (`source='gmail'` / `'calendar'` — the same rows
// the production producer reads) instead of being synthesized. The converter,
// the batch builder, the delivery sink, the minted token and the app's own read
// endpoint are all the identical production path already exercised above.
//
// SAFETY — why this is not "writing real things into the owner's app":
//  • REAL DATA, THROWAWAY OWNER. The gap was that the data was fake, never that
//    the owner was, so the synthetic ownerId is KEPT. Real Google content proves
//    the path; the throwaway owner keeps the owner's own store untouched.
//  • READ-ONLY with respect to Google. It re-delivers content the platform
//    already holds. It never reaches the draft gateway (Email stays draft-only
//    by never invoking `mail:reply` at all) and never proposes/updates/deletes a
//    calendar event, so CALENDAR_TEST_EVENT_LABEL confinement is never engaged.
//  • OFF BY DEFAULT even when an app IS configured, so an ordinary
//    `test:affected` run never touches the owner's mail.
//
// NON-VACUOUS BY CONSTRUCTION: enabling the flag is an explicit assertion that
// real data should be present, so an empty vault FAILS loudly here rather than
// skipping. A test that silently passes when it read nothing would recreate the
// very defect this item is about — a claim resting on something unexecuted.

const REAL_GOOGLE_ENABLED = process.env.APP_LIVE_REAL_GOOGLE_E2E === '1';

/**
 * Newest real vault record for a platform source, shaped as the exact
 * `ProducerSourceRecord` the production producer builds. Returns null when the
 * vault holds none, so the caller can fail with a specific reason.
 */
async function readRealSourceRecord(datatypeId: string): Promise<ProducerSourceRecord | null> {
  const client = new Client({ connectionString: getHarnessAdminUrl() });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT source, datatype_id, kind, external_id, occurred_at, title, text, metadata,
              source_id, provider_account_id
         FROM harness_shared.documents
        WHERE datatype_id = $1
          AND external_id IS NOT NULL
          AND btrim(external_id) <> ''
        ORDER BY occurred_at DESC NULLS LAST
        LIMIT 1`,
      [datatypeId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      source: row.source,
      datatypeId: row.datatype_id,
      kind: row.kind,
      externalId: row.external_id,
      occurredAt: row.occurred_at,
      title: row.title,
      text: row.text,
      metadata: row.metadata,
      sourceId: row.source_id,
      providerAccountId: row.provider_account_id,
    };
  } finally {
    await client.end();
  }
}

describe.skipIf(!REAL_GOOGLE_ENABLED || CASES.length === 0)(
  'WI-933686 real Google data → app round trip (opt-in: APP_LIVE_REAL_GOOGLE_E2E=1)',
  () => {
    for (const c of CASES) {
      describe.skipIf(!live.get(c.app))(`${c.app}`, () => {
        const ownerId = `wi933686-live-test-${randomUUID()}`;

        it('delivers a REAL vault record through the production path and the app serves it back', async () => {
          const record = await readRealSourceRecord(DATATYPE_FOR_APP[c.app]);

          // Loud rather than vacuous: opting in asserts real data IS present.
          expect(
            record,
            `no real '${c.source}' row in harness_shared.documents — ` +
              'this test cannot prove the real-data path without one. Connect the ' +
              'provider and let a sync land, or unset APP_LIVE_REAL_GOOGLE_E2E.',
          ).not.toBeNull();

          // Provenance assertions, on identifiers only — never on message content,
          // which must not reach a failure message or a CI log.
          const externalId = String(record!.externalId);
          expect(record!.source).toBe(c.source);
          expect(externalId.length).toBeGreaterThan(0);
          expect(
            record!.metadata,
            'a real vault row must carry the provider payload the app consumes',
          ).toBeTruthy();

          const mapped = appRowFromSourceRecord(record!);
          expect(mapped, `the ${c.app} datatype must map to an app`).not.toBeNull();
          expect(mapped!.app).toBe(c.app);
          // The mapper keys the app row by source id + REAL provider id (D-010).
          const rowId = appRowId(externalId, record!.sourceId);
          expect(mapped!.row.id).toBe(rowId);
          expect(mapped!.row.nativeId).toBe(externalId);

          const batch = buildAppSyncBatch(c.app, [mapped!.row], { cursor: null });
          const result = await deliverAppSyncBatch(batch, ownerId, {
            baseUrl: c.baseUrl,
            secret: c.secret,
          });
          expect(result.status).toBe(200);
          expect(result.rowCount).toBe(1);

          // RECEIVING END: the app's own read path, under a production-minted token.
          const authorization = await appServiceAuthHeader(c.app, ownerId, { secret: c.secret });
          const path = c.app === 'email' ? `/api/threads/${encodeURIComponent(rowId)}` : `/api/events/${encodeURIComponent(rowId)}`;
          const res = await fetch(`${c.baseUrl}${path}`, {
            headers: { authorization },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            messages?: { id: string }[];
            event?: { id: string };
          };

          const servedId = c.app === 'email'
            ? body.messages?.find((m) => m.id === rowId)?.id
            : body.event?.id;
          // THE ASSERTION THIS BLOCK EXISTS FOR: data that actually came from
          // Google traversed the app's own run path, and the app served it back.
          expect(
            servedId,
            `the ${c.app} app must serve back the REAL ${c.source} record it was sent`,
          ).toBe(rowId);
        });
      });
    }
  },
);
