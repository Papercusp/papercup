/**
 * GET  /api/agent-mcp/omp-config         → full settings tree
 * POST /api/agent-mcp/omp-config         → { key, value } (or { key, unset: true })
 *
 * Wraps the local `omp` CLI's config subsystem so the operator settings
 * UI can read and persist all 150+ omp knobs.
 */

import { NextRequest } from 'next/server';
import { readOmpConfig, setOmpConfig, unsetOmpConfig } from '@/lib/omp-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sections = await readOmpConfig();
    return Response.json({ ok: true, sections });
  } catch (err) {
    return Response.json(
      { ok: false, error: (err as Error).message ?? 'omp config list failed' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { key?: unknown; value?: unknown; unset?: unknown } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  const key = typeof body.key === 'string' ? body.key : '';
  if (!key) return Response.json({ ok: false, error: 'key required' }, { status: 400 });
  try {
    if (body.unset === true) {
      await unsetOmpConfig(key);
      return Response.json({ ok: true, unset: true });
    }
    const result = await setOmpConfig(key, body.value);
    return Response.json({ ok: true, raw: result.raw });
  } catch (err) {
    return Response.json(
      { ok: false, error: (err as Error).message ?? 'omp config set failed' },
      { status: 500 },
    );
  }
}
