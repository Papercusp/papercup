/**
 * POST /api/flags/webhook
 *
 * Receives flag-change notifications from the self-hosted PostHog instance
 * and broadcasts them onto the in-process flag bus, which fans out to any
 * connected /api/flags/stream subscribers.
 *
 * Auth: a shared secret stored in ~/.papercusp/posthog.json (webhookSecret)
 * or the PAPERCUSP_POSTHOG_WEBHOOK_SECRET env var must match the
 * `X-Papercusp-Webhook-Secret` header.
 *
 * PostHog's webhook payload schema varies by trigger. We treat the body
 * permissively: if we find a `key` field anywhere shaped like a flag key,
 * we emit a targeted notification; otherwise we emit a null-key event
 * (clients refetch everything).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NextResponse } from 'next/server';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';

import { publishFlagChange } from '../../../../lib/flag-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function expectedSecret(): string | null {
  const envSecret = process.env.PAPERCUSP_POSTHOG_WEBHOOK_SECRET;
  if (envSecret) return envSecret;
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), '.papercusp', 'posthog.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as { webhookSecret?: string };
    return parsed.webhookSecret ?? null;
  } catch {
    return null;
  }
}

function extractFlagKey(body: unknown): FlagKey | null {
  if (!body || typeof body !== 'object') return null;
  const stack: unknown[] = [body];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    for (const [k, v] of Object.entries(node)) {
      if (
        (k === 'key' || k === 'flag_key') &&
        typeof v === 'string' &&
        (ALL_FLAG_KEYS as readonly string[]).includes(v)
      ) {
        return v as FlagKey;
      }
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

export async function POST(req: Request) {
  const expected = expectedSecret();
  const provided = req.headers.get('x-papercusp-webhook-secret');
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, reason: 'auth' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const key = extractFlagKey(body);
  publishFlagChange(key);
  return NextResponse.json({ ok: true, key });
}
