/**
 * /api/toast-log
 *
 * POST — record a toast shown to the user. Body: { level, message, description?, harnessSlug? }
 * GET  — list recent toasts, newest first. Query: limit (default 50, max 500), since (ms)
 *
 * Captured client-side by ToastHistoryRecorder which observes the sonner
 * Toaster <ol> for new toast <li>s. Read by NotificationCenter (the bell
 * icon in the chrome).
 *
 * GET delegates to listToasts() in lib/toast-log-data.ts so the same
 * function backs the notifications:recent MCP tool.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getOrgPg, generated } from '@restart/db-org';
import { ensureToastLogTable } from '../../../lib/ensure-schema';
import { notifySyncInvalidate } from '../../../lib/sync-sse';
import { listToasts } from '../../../lib/toast-log-data';

const tl = generated.toast_logInHarness_shared;

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
  const rawHref = typeof b.actionHref === 'string' ? b.actionHref.trim() : '';
  const actionHref = rawHref && (rawHref.startsWith('/') || /^https?:\/\//i.test(rawHref))
    ? rawHref.slice(0, 2000)
    : null;
  const createdAt = Date.now();

  await ensureToastLogTable();
  const { db, sql } = getOrgPg();
  const [row] = await db
    .insert(tl)
    .values({
      level,
      message,
      description,
      harness_slug: harnessSlug,
      created_at: createdAt,
      action_label: actionLabel,
      action_href: actionHref,
    })
    .returning({ id: tl.id });

  // Ring-buffer trim: DELETE WHERE id IN (SELECT id ... ORDER BY ... OFFSET N).
  // The subquery pattern is awkward in drizzle's query builder; keep this raw.
  void sql`
    DELETE FROM harness_shared.toast_log
    WHERE id IN (
      SELECT id FROM harness_shared.toast_log
      ORDER BY created_at DESC
      OFFSET ${RING_BUFFER_SIZE}
    )
  `.catch(() => {});

  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});

  return NextResponse.json({ id: Number(row.id), createdAt });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? '50') || 50;
  const since = Number(url.searchParams.get('since') ?? '0') || 0;
  const slug = url.searchParams.get('slug');
  const result = await listToasts({ limit, since, slug });
  return NextResponse.json(result);
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
