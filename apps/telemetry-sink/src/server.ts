/**
 * Reference telemetry sink for Papercusp desktop.
 *
 * Endpoints:
 *   POST /report     — receives a single telemetry report
 *   GET  /healthz    — liveness (200 if running)
 *   GET  /readyz     — readiness (200 if PG is reachable)
 *
 * Wire shape (from apps/operator/lib/telemetry-flush.ts):
 *   {
 *     workspace_id: string,
 *     received_at:  string (ISO timestamp or PG timestamptz cast),
 *     kind:         string,
 *     app_version?: string | null,
 *     os?:          string | null,
 *     payload?:     unknown
 *   }
 *
 * Auth: if PAPERCUSP_TELEMETRY_SINK_TOKEN is set, requests must include
 * `Authorization: Bearer <token>`. When unset, the endpoint accepts
 * anonymous POSTs (useful for closed networks; rate-limit still applies).
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { IncomingMessage } from 'node:http';
import { insertEvent, ping, type IncomingReport } from './storage.js';
import { take } from './rate-limit.js';

interface NodeBindings {
  incoming: IncomingMessage;
}

const app = new Hono<{ Bindings: NodeBindings }>();

const EXPECTED_TOKEN = process.env.PAPERCUSP_TELEMETRY_SINK_TOKEN ?? '';
const MAX_BODY_BYTES = Number(process.env.PAPERCUSP_TELEMETRY_MAX_BODY_BYTES ?? 32 * 1024);
const ALLOWED_KIND_RE = /^[a-z0-9_\-]{1,64}$/i;

app.get('/healthz', (c) => c.text('ok'));

app.get('/readyz', async (c) => {
  try {
    await ping();
    return c.text('ok');
  } catch (e: any) {
    return c.text(`db: ${e?.message ?? String(e)}`, 503);
  }
});

app.post('/report', async (c) => {
  // Auth
  if (EXPECTED_TOKEN) {
    const header = c.req.header('Authorization') ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (supplied !== EXPECTED_TOKEN) {
      return c.json({ error: 'unauthorized' }, 401);
    }
  }

  // Source IP (X-Forwarded-For wins behind a CDN, else remote addr).
  const xff = c.req.header('X-Forwarded-For') ?? '';
  const sourceIp =
    xff.split(',')[0]?.trim() || c.env?.incoming?.socket?.remoteAddress || null;

  // Rate limit
  const rl = take(sourceIp ?? 'unknown');
  if (!rl.ok) {
    return c.json(
      { error: 'rate limited' },
      429,
      { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) },
    );
  }

  // Size cap before parsing
  const cl = Number(c.req.header('Content-Length') ?? '0');
  if (cl > MAX_BODY_BYTES) {
    return c.json({ error: 'body too large' }, 413);
  }

  // Parse + validate
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'body must be an object' }, 400);
  }
  if (typeof body.workspace_id !== 'string' || body.workspace_id.length === 0 || body.workspace_id.length > 128) {
    return c.json({ error: 'invalid workspace_id' }, 400);
  }
  if (typeof body.received_at !== 'string' || isNaN(Date.parse(body.received_at))) {
    return c.json({ error: 'invalid received_at' }, 400);
  }
  if (typeof body.kind !== 'string' || !ALLOWED_KIND_RE.test(body.kind)) {
    return c.json({ error: 'invalid kind' }, 400);
  }
  if (body.app_version != null && (typeof body.app_version !== 'string' || body.app_version.length > 64)) {
    return c.json({ error: 'invalid app_version' }, 400);
  }
  if (body.os != null && (typeof body.os !== 'string' || body.os.length > 64)) {
    return c.json({ error: 'invalid os' }, 400);
  }

  const report: IncomingReport = {
    workspace_id: body.workspace_id,
    received_at: body.received_at,
    kind: body.kind,
    app_version: body.app_version ?? null,
    os: body.os ?? null,
    payload: body.payload ?? null,
  };

  try {
    const id = await insertEvent(report, sourceIp);
    return c.json({ ok: true, id });
  } catch (e: any) {
    console.error('[telemetry-sink] insert failed:', e?.message ?? e);
    return c.json({ error: 'storage failed' }, 502);
  }
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, ({ port }) => {
  console.log(`[telemetry-sink] listening on :${port}`);
  if (!EXPECTED_TOKEN) {
    console.warn('[telemetry-sink] PAPERCUSP_TELEMETRY_SINK_TOKEN unset — endpoint is anonymous');
  }
});
