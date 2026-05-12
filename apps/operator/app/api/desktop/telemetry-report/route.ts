/**
 * POST /api/desktop/telemetry-report
 *
 * Accepts an anonymized crash / diagnostic report from the desktop app
 * when the user has opted in via the Setup Wizard's telemetry step.
 *
 * Storage: bounded ring buffer in operator_user_profile-style key/value
 * (key: 'telemetry_reports', most-recent-100). A real retention table
 * with daily partitioning is a follow-up — for now this is enough to
 * confirm reports are landing and to inspect them locally.
 *
 * The opt-in itself lives on the setup_wizard_state record; this route
 * checks that flag and rejects with 403 if telemetry is disabled, so a
 * misbehaving build (or stale tab) can't keep sending after opt-out.
 *
 * Trust model: loopback-only. Same as the other /api/desktop/* routes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readOperatorState, writeOperatorState } from '@/lib/operator-state-pg';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REPORTS_KEY = 'telemetry_reports';
const WIZARD_KEY = 'setup_wizard_state';
const MAX_REPORTS = 100;

interface StoredReport {
  received_at: string;
  kind: string;
  app_version?: string;
  os?: string;
  payload: unknown;
}

interface ReportsState {
  reports: StoredReport[];
}

function isLoopback(req: NextRequest): boolean {
  const host = req.headers.get('host') ?? '';
  return (
    host.startsWith('127.0.0.1:') ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host === 'localhost'
  );
}

function defaults(): ReportsState {
  return { reports: [] };
}

export async function GET(req: NextRequest) {
  if (!isLoopback(req)) return NextResponse.json({ error: 'loopback only' }, { status: 403 });
  const state = (await readOperatorState<ReportsState>(REPORTS_KEY)) ?? defaults();
  return NextResponse.json(state);
}

export async function POST(req: NextRequest) {
  if (!isLoopback(req)) return NextResponse.json({ error: 'loopback only' }, { status: 403 });
  const wizard = await readOperatorState<{ telemetry_enabled?: boolean }>(WIZARD_KEY);
  if (!wizard?.telemetry_enabled) {
    return NextResponse.json({ error: 'telemetry disabled' }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const kind = typeof body.kind === 'string' ? body.kind : 'unknown';
  if (kind.length > 64) return NextResponse.json({ error: 'kind too long' }, { status: 400 });

  const report: StoredReport = {
    received_at: new Date().toISOString(),
    kind,
    app_version: typeof body.app_version === 'string' ? body.app_version : undefined,
    os: typeof body.os === 'string' ? body.os : undefined,
    payload: body.payload ?? null,
  };

  const current = (await readOperatorState<ReportsState>(REPORTS_KEY)) ?? defaults();
  const next: ReportsState = {
    reports: [report, ...current.reports].slice(0, MAX_REPORTS),
  };
  await writeOperatorState(REPORTS_KEY, next);
  return NextResponse.json({ ok: true, stored: report });
}
