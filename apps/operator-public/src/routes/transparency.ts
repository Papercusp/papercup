/**
 * Public transparency report (agent-economy-flywheel-2026-08-30 P-044, D-028).
 *
 * Operator pushes, HMAC-signed with the reconciliation secret:
 *   PUT TRANSPARENCY_LIVE_PATH       the hourly live report (open month, provisional)
 *   PUT TRANSPARENCY_STATEMENT_PATH  a signed monthly statement; the Worker checks its
 *                                    digest and EIP-191 signature, then stores it
 *                                    IMMUTABLY (first publication wins, 409 on drift)
 * Public reads, no auth:
 *   GET /transparency/:workspaceId                     live report + statement index
 *   GET /transparency/:workspaceId/statements/:month   one signed statement
 */
import { Hono } from 'hono';
import {
  RECONCILIATION_SIGNATURE_HEADER,
  RECONCILIATION_SIGNATURE_TOLERANCE_MS,
  TRANSPARENCY_LIVE_PATH,
  TRANSPARENCY_STATEMENT_PATH,
  verifyReconciliationRequest,
} from '@papercusp/operator-core/lib/cupboard/reconciliation-hmac.ts';
import { parseSignedStatement, verifySignedStatement } from '@papercusp/operator-core/lib/cupboard/transparency-statement.ts';
import type { Env } from '../env.ts';
import { listStatements, publishStatement, readLiveReport, readStatement, recordLiveReport } from '../transparency-store.ts';

const MONTH = /^\d{4}-\d{2}$/;

export function transparencyRoute(options: { now?: () => number } = {}): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();
  const now = options.now ?? Date.now;

  /** Verify the operator's HMAC, then hand back the parsed JSON body (or a response to return). */
  async function signedJson(c: { env: Env; req: { text(): Promise<string>; header(name: string): string | undefined } }, pathname: string) {
    const body = await c.req.text();
    const verdict = await verifyReconciliationRequest({
      secret: c.env.RECONCILIATION_GATE_SECRET,
      header: c.req.header(RECONCILIATION_SIGNATURE_HEADER),
      method: 'PUT',
      pathname,
      body,
      nowMs: now(),
    });
    if (!verdict.ok) {
      return verdict.reason === 'not-configured'
        ? ({ error: { error: 'not_configured', detail: 'RECONCILIATION_GATE_SECRET is not configured' }, status: 503 } as const)
        : ({ error: { error: 'unauthorized', reason: verdict.reason }, status: 401 } as const);
    }
    try {
      return { json: JSON.parse(body) as unknown };
    } catch {
      return { error: { error: 'invalid_request', detail: 'body is not JSON' }, status: 400 } as const;
    }
  }

  route.put(TRANSPARENCY_LIVE_PATH, async (c) => {
    const r = await signedJson(c, TRANSPARENCY_LIVE_PATH);
    if ('error' in r) return c.json(r.error, r.status);
    const push = r.json as { workspaceId?: unknown; month?: unknown; generatedAtMs?: unknown; report?: { workspaceId?: unknown; kind?: unknown; month?: unknown } };
    const valid =
      typeof push?.workspaceId === 'string' &&
      typeof push.month === 'string' &&
      MONTH.test(push.month) &&
      typeof push.generatedAtMs === 'number' &&
      Number.isFinite(push.generatedAtMs) &&
      push.report?.kind === 'live' &&
      push.report.workspaceId === push.workspaceId &&
      push.report.month === push.month;
    if (!valid) return c.json({ error: 'invalid_request', detail: 'not a live transparency push' }, 400);
    const nowMs = now();
    if ((push.generatedAtMs as number) > nowMs + RECONCILIATION_SIGNATURE_TOLERANCE_MS) {
      return c.json({ error: 'invalid_request', detail: 'generatedAtMs is in the future' }, 400);
    }
    const stored = await recordLiveReport(c.env.DB, {
      workspaceId: push.workspaceId as string,
      month: push.month as string,
      reportJson: JSON.stringify(push.report),
      generatedAtMs: push.generatedAtMs as number,
      receivedAtMs: nowMs,
    });
    return c.json({ ok: true, stored });
  });

  route.put(TRANSPARENCY_STATEMENT_PATH, async (c) => {
    const r = await signedJson(c, TRANSPARENCY_STATEMENT_PATH);
    if ('error' in r) return c.json(r.error, r.status);
    const signed = parseSignedStatement(r.json);
    if (!signed) return c.json({ error: 'invalid_request', detail: 'not a signed monthly statement' }, 400);
    const check = await verifySignedStatement(signed);
    if (!check.ok) return c.json({ error: 'invalid_statement', detail: check.reason }, 400);
    const write = await publishStatement(c.env.DB, signed, now());
    if (typeof write === 'object') {
      return c.json({ error: 'statement_exists', detail: `month ${signed.statement.report.month} is already published with digest ${write.conflict}` }, 409);
    }
    return c.json({ ok: true, published: write, digest: signed.digest });
  });

  route.get('/transparency/:workspaceId', async (c) => {
    const workspaceId = c.req.param('workspaceId');
    const [live, statements] = await Promise.all([readLiveReport(c.env.DB, workspaceId), listStatements(c.env.DB, workspaceId)]);
    if (!live && statements.length === 0) return c.json({ error: 'not_found', detail: `no transparency report for '${workspaceId}'` }, 404);
    return c.json({ workspaceId, live, statements });
  });

  route.get('/transparency/:workspaceId/statements/:month', async (c) => {
    const month = c.req.param('month');
    if (!MONTH.test(month)) return c.json({ error: 'invalid_request', detail: 'month is YYYY-MM' }, 400);
    const signed = await readStatement(c.env.DB, c.req.param('workspaceId'), month);
    return signed ? c.json(signed) : c.json({ error: 'not_found', detail: `no statement for ${month}` }, 404);
  });

  return route;
}
