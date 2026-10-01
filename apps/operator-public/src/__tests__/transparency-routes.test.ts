/**
 * P-044 (D-028 §3–4): the Worker stores the operator's signed pushes and serves
 * them publicly. A live report only moves forward; a monthly statement must verify
 * against its signer and is immutable once published. Real SQLite, real migrations.
 */
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
// The PG-free core of the operator's pass (the runtime adds only its Postgres / key-file defaults).
import { cupboardTransparencyWorker, publishTransparency } from '@papercusp/operator-core/lib/cupboard/transparency-publish.ts';
import {
  RECONCILIATION_SIGNATURE_HEADER,
  TRANSPARENCY_LIVE_PATH,
  TRANSPARENCY_STATEMENT_PATH,
  signReconciliationRequest,
} from '@papercusp/operator-core/lib/cupboard/reconciliation-hmac.ts';
import { journalEntryForMovement, type JournalEntry } from '@papercusp/operator-core/lib/cupboard/money-journal.ts';
import { buildMonthlyStatement, buildTransparencyReport, monthPeriod, treasuryFigure } from '@papercusp/operator-core/lib/cupboard/transparency-report.ts';
import {
  signStatement,
  verifySignedStatement,
  type LiveTransparencyPush,
  type SignedStatement,
  type StatementStatus,
} from '@papercusp/operator-core/lib/cupboard/transparency-statement.ts';
import { buildApi } from '../routes/index.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';

// A low-entropy test key, not a credential.
const KEY = 't'.repeat(32);
const WS = 'ws-transparency';

function harness() {
  const { db } = makeSqliteDb();
  const { env } = makeEnv();
  env.DB = db;
  env.RECONCILIATION_GATE_SECRET = KEY;
  return { api: buildApi(), env };
}
type H = ReturnType<typeof harness>;

async function put(h: H, path: string, payload: unknown, key = KEY) {
  const body = JSON.stringify(payload);
  const signature = await signReconciliationRequest({ secret: key, method: 'PUT', pathname: path, body, nowMs: Date.now() });
  return h.api.request(path, { method: 'PUT', headers: { 'content-type': 'application/json', [RECONCILIATION_SIGNATURE_HEADER]: signature }, body }, h.env);
}
const get = (h: H, path: string) => h.api.request(path, { method: 'GET' }, h.env);

function journal(extraCents = 0): JournalEntry[] {
  const r = journalEntryForMovement({
    entryId: 'pay-1',
    occurredAtMs: Date.UTC(2026, 8, 3),
    currency: 'USD',
    externalRef: { kind: 'stripe-balance-transaction', id: 'txn_1' },
    movement: { kind: 'customer-payment', grossCents: 10_000 + extraCents, feeCents: 300, taxCents: 0, daoCents: 1_000, refundReserveCents: 0 },
  });
  if (!r.ok) throw new Error('fixture rejected');
  return [r.entry];
}

const treasury = treasuryFigure(null, 'not measured in this test');

const PENDING: StatementStatus = { status: 'pending', month: '2026-08', digest: null, withheldBy: [], detail: 'awaiting the month-close run' };

function liveReport(generatedAtMs: number, extraCents = 0): LiveTransparencyPush {
  const report = buildTransparencyReport({ workspaceId: WS, kind: 'live', entries: journal(extraCents), period: monthPeriod('2026-09'), provisional: true, treasury, latestAnchor: null });
  return { workspaceId: WS, month: '2026-09', generatedAtMs, report, statementStatus: PENDING };
}

async function statement(key: `0x${string}`, extraCents = 0): Promise<SignedStatement> {
  const b = buildMonthlyStatement({
    workspaceId: WS,
    entries: journal(extraCents),
    run: { runId: 'run-final', mode: 'final', month: '2026-09', finishedAt: '2026-10-01T00:30:00.000Z', verdicts: [{ invariant: 'journal-matches-stripe', status: 'ok' }] },
    treasury,
    latestAnchor: null,
  });
  if (!b.ok) throw new Error('expected a statement');
  return signStatement(b.statement, key);
}

describe('transparency routes (P-044)', () => {
  it('stores the live report and serves it publicly; a delayed older push never rolls it back', async () => {
    const h = harness();
    const t = Date.now() - 60_000;
    expect(await (await put(h, TRANSPARENCY_LIVE_PATH, liveReport(t, 500))).json()).toEqual({ ok: true, stored: 'stored' });
    expect(await (await put(h, TRANSPARENCY_LIVE_PATH, liveReport(t - 3_600_000))).json()).toEqual({ ok: true, stored: 'stale' });

    const res = await get(h, `/transparency/${WS}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { live: { month: string; generatedAtMs: number; report: { revenueCents: number; provisional: boolean }; statementStatus: StatementStatus }; statements: unknown[] };
    expect(body.live).toMatchObject({ month: '2026-09', generatedAtMs: t, report: { provisional: true }, statementStatus: PENDING });
    expect(body.live.report.revenueCents).toBe(liveReport(t, 500).report.revenueCents);
    expect(body.statements).toEqual([]);
  });

  it('refuses unsigned or mis-signed pushes and malformed live bodies', async () => {
    const h = harness();
    expect((await put(h, TRANSPARENCY_LIVE_PATH, liveReport(Date.now()), 'x'.repeat(32))).status).toBe(401);
    expect((await put(h, TRANSPARENCY_LIVE_PATH, { ...liveReport(Date.now()), month: 'Sept' })).status).toBe(400);
    const otherWs = liveReport(Date.now());
    expect((await put(h, TRANSPARENCY_LIVE_PATH, { ...otherWs, workspaceId: 'someone-else' })).status).toBe(400);
    const { statementStatus: _omitted, ...noStatus } = liveReport(Date.now());
    expect((await put(h, TRANSPARENCY_LIVE_PATH, noStatus)).status).toBe(400);
    expect((await put(h, TRANSPARENCY_LIVE_PATH, { ...otherWs, statementStatus: { ...PENDING, status: 'final' } })).status).toBe(400);
    expect((await get(h, `/transparency/${WS}`)).status).toBe(404);
  });

  it('publishes a signed statement once; it verifies from the public read; a different digest is refused 409', async () => {
    const h = harness();
    const key = generatePrivateKey();
    const signed = await statement(key);
    expect(await (await put(h, TRANSPARENCY_STATEMENT_PATH, signed)).json()).toEqual({ ok: true, published: 'created', digest: signed.digest });
    expect(await (await put(h, TRANSPARENCY_STATEMENT_PATH, signed)).json()).toEqual({ ok: true, published: 'unchanged', digest: signed.digest });

    const drift = await statement(key, 1);
    const refused = await put(h, TRANSPARENCY_STATEMENT_PATH, drift);
    expect(refused.status).toBe(409);

    const pub = await get(h, `/transparency/${WS}/statements/2026-09`);
    expect(pub.status).toBe(200);
    const served = (await pub.json()) as SignedStatement;
    expect(served.digest).toBe(signed.digest);
    // A reader with nothing but the public JSON can verify it.
    expect(await verifySignedStatement(served)).toEqual({ ok: true });
    const index = (await (await get(h, `/transparency/${WS}`)).json()) as { statements: { month: string; digest: string; signer: string }[] };
    expect(index.statements).toEqual([{ month: '2026-09', digest: signed.digest, signer: signed.signer, publishedAtMs: expect.any(Number) }]);
  });

  it('end to end: the operator pass publishes through the signed routes and a public reader verifies the statement to the anchor key', async () => {
    const h = harness();
    const key = generatePrivateKey();
    const nowMs = Date.UTC(2026, 9, 1, 10);
    const sept = journal();
    const septEnd = Date.UTC(2026, 9, 1) / 1000;
    const anchor = {
      anchorSeq: 1, logId: `ledger-anchor:${WS}`, logRoot: 'cd'.repeat(32), treeSize: 4, windowStart: septEnd - 3600, windowEnd: septEnd,
      backend: 'eas', chainId: 84532, ref: `0x${'e'.repeat(64)}`, txHash: `0x${'f'.repeat(64)}`, attester: null, consistencyFrom: 0, consistencyProof: [],
    };
    const finalRun = {
      runId: 'final-2026-09', mode: 'final' as const, month: '2026-09', startedAt: '2026-10-01T00:30:00.000Z', finishedAt: '2026-10-01T00:31:00.000Z',
      gateOpen: true, gateReasons: [], gatePublished: true, gatePublishDetail: null, opened: [], resolved: [],
      verdicts: [{ invariant: 'journal-matches-stripe' as const, status: 'ok' as const, detail: 'matches' }],
    };
    const worker = cupboardTransparencyWorker({
      baseUrl: 'https://cupboard.test',
      secret: KEY,
      // The signed PUTs carry real HMACs; the Worker checks them at its own clock.
      now: Date.now,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
        return h.api.request(`${u.pathname}${u.search}`, init ?? {}, h.env);
      }) as typeof fetch,
    });
    const run = () =>
      publishTransparency({
        workspaces: [WS],
        worker,
        workerUnavailable: null,
        now: () => nowMs,
        readEntries: async () => sept,
        readReconciliation: async () => ({ latestFinal: finalRun, openBreaks: [] }),
        anchors: async () => [anchor],
        treasury: async () => treasury,
        signingKey: () => ({ ok: true, privateKey: key }),
        drift: async () => undefined,
      });

    const first = await run();
    expect(first.workspaces[0]).toMatchObject({ live: { pushed: true, stored: 'stored' }, statement: { status: 'published', month: '2026-09' }, error: null });
    const second = await run();
    expect(second.workspaces[0]!.statement).toMatchObject({ status: 'published', detail: 'published' });

    const page = (await (await get(h, `/transparency/${WS}`)).json()) as {
      live: { month: string; report: { kind: string; latestAnchor: { logRoot: string } | null }; statementStatus: StatementStatus };
      statements: { month: string; signer: string }[];
    };
    expect(page.live.month).toBe('2026-10');
    expect(page.live.report.latestAnchor?.logRoot).toBe(anchor.logRoot);
    expect(page.live.statementStatus).toMatchObject({ status: 'published', month: '2026-09' });
    expect(page.statements).toEqual([expect.objectContaining({ month: '2026-09', signer: privateKeyToAccount(key).address })]);

    const served = (await (await get(h, `/transparency/${WS}/statements/2026-09`)).json()) as SignedStatement;
    expect(await verifySignedStatement(served)).toEqual({ ok: true });
    expect(served.signer).toBe(privateKeyToAccount(key).address);
    expect(served.statement.report.latestAnchor?.txHash).toBe(anchor.txHash);
  });

  it('refuses a statement whose figures were altered after signing', async () => {
    const h = harness();
    const signed = await statement(generatePrivateKey());
    const tampered = { ...signed, statement: { ...signed.statement, report: { ...signed.statement.report, revenueCents: 1 } } };
    const res = await put(h, TRANSPARENCY_STATEMENT_PATH, tampered);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_statement', detail: 'digest does not match the statement' });
    expect((await get(h, `/transparency/${WS}/statements/2026-09`)).status).toBe(404);
  });
});
