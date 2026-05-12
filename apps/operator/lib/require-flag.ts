/**
 * Server-side feature-flag gates for Next.js App Router pages and route
 * handlers.
 *
 * `requireFlag(key)` is for `page.tsx` server components: calls
 * `notFound()` (rendering the 404 page) when the flag is off. Use this
 * for V1-cut surfaces so a deep link does not silently land on a stale
 * UI.
 *
 * `gateApiRoute(req, key)` is for `app/api/.../route.ts`: returns a 404
 * NextResponse to short-circuit the handler, or null when the flag is on
 * (continue with the normal handler).
 *
 * Both fall back to FLAG_DEFAULTS[key] (false) when PostHog is
 * unreachable: a closed gate is the safe state when we cannot verify
 * what the flag says.
 */
import { notFound } from 'next/navigation';
import { NextResponse } from 'next/server';

import type { FlagKey } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

import { resolveDistinctId } from './flag-distinct-id';
import '@/lib/flag-bus';

export async function requireFlag(key: FlagKey): Promise<void> {
  const fakeReq = new Request('http://localhost/');
  const enabled = await getFlag(key, resolveDistinctId(fakeReq));
  if (!enabled) notFound();
}

export async function gateApiRoute(
  req: Request,
  key: FlagKey,
): Promise<NextResponse | null> {
  const enabled = await getFlag(key, resolveDistinctId(req));
  if (enabled) return null;
  return NextResponse.json(
    { ok: false, reason: 'feature-disabled', flag: key },
    { status: 404 },
  );
}
