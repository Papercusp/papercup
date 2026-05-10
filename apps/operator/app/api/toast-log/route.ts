/**
 * /api/toast-log
 *
 * POST — record a toast shown to the user. Body: { level, message, description?, harnessSlug? }
 * GET  — list recent toasts, newest first. Query: limit (default 50, max 500), since (ms)
 *
 * Captured client-side by ToastHistoryRecorder which observes the sonner
 * Toaster <ol> for new toast <li>s. Read by NotificationCenter (the bell
 * icon in the chrome).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { ensureToastLogTable } from '../../../lib/ensure-schema';
import { notifySyncInvalidate } from '../../../lib/sync-sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_MESSAGE_LEN = 2000;
const MAX_DESCRIPTION_LEN = 8000;
// Cap the table at this many rows; trim oldest after each insert so the
// log can't grow unboundedly. Plenty of headroom for normal app usage —
// a user that sees 50 toasts per session and runs the app 10 sessions a
// day still has 4 days of history before the cap kicks in.
const RING_BUFFER_SIZE = 2000;

const VALID_LEVELS = new Set(['default', 'info', 'success', 'warning', 'error', 'loading']);

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const level = typeof b.level === 'string' && VALID_LEVELS.has(b.level) ? b.level : 'default';
  const message = typeof b.message === 'string' ? b.message.slice(0, MAX_MESSAGE_LEN).trim() : '';
  if (!message) {
    return NextResponse.json({ error: 'message required' }, { status: 400 });
  }
  const description =
    typeof b.description === 'string' && b.description.trim()
      ? b.description.slice(0, MAX_DESCRIPTION_LEN)
      : null;
  const harnessSlug =
    typeof b.harnessSlug === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(b.harnessSlug)
      ? b.harnessSlug
      : null;
  const actionLabel =
    typeof b.actionLabel === 'string' && b.actionLabel.trim()
      ? b.actionLabel.slice(0, 120).trim()
      : null;
  // Only same-origin paths and explicit external URLs allowed; no
  // javascript: or data: schemes that would be a click-through risk.
  const rawHref = typeof b.actionHref === 'string' ? b.actionHref.trim() : '';
  const actionHref = rawHref && (rawHref.startsWith('/') || /^https?:\/\//i.test(rawHref))
    ? rawHref.slice(0, 2000)
    : null;
  const createdAt = Date.now();

  await ensureToastLogTable();
  const { sql } = getOrgPg();
  const [row] = (await sql`
    INSERT INTO harness_shared.toast_log
      (level, message, description, harness_slug, created_at, action_label, action_href)
    VALUES
      (${level}, ${message}, ${description}, ${harnessSlug}, ${createdAt}, ${actionLabel}, ${actionHref})
    RETURNING id
  `) as Array<{ id: string }>;

  // Best-effort ring-buffer trim. Runs out-of-band so the response isn't
  // delayed; failure is non-fatal (worst case the table grows another row).
  void sql`
    DELETE FROM harness_shared.toast_log
    WHERE id IN (
      SELECT id FROM harness_shared.toast_log
      ORDER BY created_at DESC
      OFFSET ${RING_BUFFER_SIZE}
    )
  `.catch(() => {});

  // Phase 1 push: NotificationCenter subscribes via toastLog.recent — emit
  // an invalidate so it refetches without waiting for poll cadence.
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});

  return NextResponse.json({ id: Number(row.id), createdAt });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '50') || 50));
  const since = Number(url.searchParams.get('since') ?? '0') || 0;
  const slugFilter = url.searchParams.get('slug');
  const slugClause = slugFilter && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slugFilter) ? slugFilter : null;

  await ensureToastLogTable();
  const { sql } = getOrgPg();
  const rows = slugClause
    ? ((await sql`
        SELECT id, level, message, description, harness_slug, created_at, action_label, action_href
        FROM harness_shared.toast_log
        WHERE created_at >= ${since}
          AND harness_slug = ${slugClause}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `) as Array<Row>)
    : ((await sql`
        SELECT id, level, message, description, harness_slug, created_at, action_label, action_href
        FROM harness_shared.toast_log
        WHERE created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `) as Array<Row>);

  return NextResponse.json({
    toasts: rows.map((r) => ({
      id: Number(r.id),
      level: r.level,
      message: r.message,
      description: r.description,
      harnessSlug: r.harness_slug,
      createdAt: Number(r.created_at),
      actionLabel: r.action_label,
      actionHref: r.action_href,
    })),
  });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const all = url.searchParams.get('all') === '1';
  await ensureToastLogTable();
  const { sql } = getOrgPg();
  if (all) {
    await sql`DELETE FROM harness_shared.toast_log`;
    return NextResponse.json({ ok: true, cleared: 'all' });
  }
  return NextResponse.json({ error: 'pass ?all=1 to clear' }, { status: 400 });
}

interface Row {
  id: string;
  level: string;
  message: string;
  description: string | null;
  harness_slug: string | null;
  created_at: string;
  action_label: string | null;
  action_href: string | null;
}
