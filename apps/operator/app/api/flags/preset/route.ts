/**
 * POST /api/flags/preset
 *   body: { name: 'production' | 'testing' }
 *
 * Atomic preset apply. Two named modes:
 *
 * - 'production' → testingFeatures=false. Operator stops contacting
 *   PostHog. Bundled defaults (all flags false) serve everything =
 *   V1 ship state. PostHog values are left alone; they're irrelevant
 *   when testingFeatures=false.
 *
 * - 'testing' → testingFeatures=true + flip every PostHog flag to
 *   `active=true`. Full feature set live.
 *
 * Returns the resulting effective state plus per-flag flip results
 * (only meaningful for 'testing').
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NextResponse } from 'next/server';

import { ALL_FLAG_KEYS } from '@papercusp/flags';
import { setFlag } from '@papercusp/flags/server';
import { publishFlagChange } from '@/lib/flag-bus';
import { resetPosthogConfigForTest } from '@/lib/posthog-config';
import '@/lib/flag-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CONFIG_PATH = path.join(os.homedir(), '.papercusp', 'posthog.json');

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

export async function POST(req: Request) {
  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const name = body.name;
  if (name !== 'production' && name !== 'testing') {
    return NextResponse.json(
      { ok: false, error: "name must be 'production' or 'testing'" },
      { status: 400 },
    );
  }

  if (name === 'production') {
    const cfg = readConfig();
    cfg.testingFeatures = false;
    writeConfig(cfg);
    resetPosthogConfigForTest();
    publishFlagChange(null);
    return NextResponse.json({ ok: true, preset: 'production', testingFeatures: false });
  }

  // 'testing': turn on testingFeatures + flip every flag on in PostHog
  const cfg = readConfig();
  cfg.testingFeatures = true;
  writeConfig(cfg);
  resetPosthogConfigForTest();

  const results: Record<string, boolean | string> = {};
  for (const key of ALL_FLAG_KEYS) {
    const r = await setFlag(key, true);
    results[key] = r.ok ? true : r.reason;
  }
  publishFlagChange(null);

  return NextResponse.json({
    ok: true,
    preset: 'testing',
    testingFeatures: true,
    results,
  });
}
