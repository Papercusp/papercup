/**
 * POST /api/flags/set
 *   body: { key: FlagKey, enabled: boolean }
 *
 * Flips a single Papercusp feature flag in PostHog and broadcasts the
 * change onto the in-process flag bus. Used by the /admin/features UI
 * to flip flags interactively. Mirrors the `flags:set` MCP tool but
 * without the audit-write requirement (the admin UI is its own audit
 * surface — operators can see who flipped what via PostHog's history).
 *
 * Requires `testingFeatures: true` in the discovery file: with it
 * off, the operator never contacts PostHog and the call would no-op.
 */
import { NextResponse } from 'next/server';
import {
  ALL_FLAG_KEYS,
  type FlagKey,
} from '@papercusp/flags';
import { setFlag } from '@papercusp/flags/server';
import { publishFlagChange } from '@/lib/flag-bus';
import '@/lib/flag-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { key?: string; enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const key = body.key as FlagKey | undefined;
  const enabled = body.enabled;
  if (!key || !ALL_FLAG_KEYS.includes(key)) {
    return NextResponse.json({ ok: false, error: 'unknown flag key' }, { status: 400 });
  }
  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'enabled must be boolean' }, { status: 400 });
  }

  const result = await setFlag(key, enabled);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.reason, key }, { status: 502 });
  }
  publishFlagChange(key);

  return NextResponse.json({ ok: true, key, enabled });
}
