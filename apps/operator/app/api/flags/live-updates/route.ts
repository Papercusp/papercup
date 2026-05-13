/**
 * GET  /api/flags/live-updates  - returns { liveUpdates: boolean, source: string }
 * POST /api/flags/live-updates  - body { enabled: boolean }, persists to
 *                                ~/.papercusp/posthog.json
 *
 * "Live updates" is Papercusp's opt-in to remote feature-flag fetches.
 * When OFF (the default), the operator uses bundled FLAG_DEFAULTS and
 * NEVER makes any outbound request to PostHog. When ON, posthog-node
 * is initialized and the operator fetches flag definitions from
 * flags.papercuspai.com. No analytics, replay, or telemetry are sent
 * either way — that's a separate opt-in.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NextResponse } from 'next/server';

import {
  getPosthogConfigWithSource,
  resetPosthogConfigForTest,
} from '../../../../lib/posthog-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CONFIG_PATH = path.join(os.homedir(), '.papercusp', 'posthog.json');

export function GET() {
  const { liveUpdates, source } = getPosthogConfigWithSource();
  return NextResponse.json({ liveUpdates, source });
}

export async function POST(req: Request) {
  let body: { enabled?: unknown };
  try {
    body = (await req.json()) as { enabled?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json(
      { ok: false, error: 'enabled must be a boolean' },
      { status: 400 },
    );
  }

  let parsed: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    // file may not exist yet — we'll create it with the bare minimum
  }
  parsed.liveUpdates = body.enabled;

  await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(parsed, null, 2) + '\n', {
    mode: 0o600,
  });

  // bust the in-process config cache so the next request picks up the new value
  resetPosthogConfigForTest();

  return NextResponse.json({ ok: true, liveUpdates: body.enabled });
}
