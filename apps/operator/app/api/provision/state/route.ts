/**
 * GET /api/provision/state?harness=<h>&plugin=<p>
 *
 * Returns the current provision state for a (harness, plugin) pair —
 * hashes, recorded resources, last setup/verify timestamps, and the
 * `setupFailed` banner flag.
 *
 * Used by the harness UI to decide whether to surface a "Re-provision
 * needed" banner.
 */

import { NextResponse } from 'next/server';
import { readState } from '@/lib/provision/state-store';
import { readAudit } from '@/lib/provision/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const harness = url.searchParams.get('harness') ?? '';
  const plugin = url.searchParams.get('plugin') ?? '';
  const auditLimit = parseInt(url.searchParams.get('auditLimit') ?? '50', 10);
  if (!harness || !plugin) {
    return NextResponse.json({ ok: false, error: 'harness + plugin required' }, { status: 400 });
  }
  const state = await readState(harness, plugin);
  const audit = await readAudit(harness, plugin, { limit: auditLimit });
  return NextResponse.json({ ok: true, state, audit });
}
