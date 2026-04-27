/**
 * GET /api/desktop/version
 *
 * Returns minimal "what's running" info for the harness UI's bottom-right
 * pill. Used to:
 *   - Show the running version + sha to the user (read-only).
 *   - Detect server restarts: when sha changes between polls, the pill
 *     turns amber and offers a click-to-reload (so users see edits land
 *     without watching the dev log).
 *
 * Intentionally does NOT poll GitHub Releases — that's a separate (heavier)
 * "is there a published update available?" feature. This endpoint only
 * answers "what is this sidecar instance running right now?".
 */
import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const startedAtMs = Date.now();

function detectGitSha(): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      cwd: process.cwd(),
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim();
  } catch {
    return 'unknown';
  }
}
const sidecarSha = detectGitSha();

function detectAppVersion(): string {
  // Tauri's main.rs can set this on spawn (when bundled in the desktop app).
  if (process.env.PAPERCUSP_DESKTOP_VERSION) {
    return process.env.PAPERCUSP_DESKTOP_VERSION;
  }
  // Best-effort: read apps/papercusp-desktop/package.json relative to a few
  // plausible CWDs (dev sidecar / production sidecar / repo root).
  const candidates = [
    join(process.cwd(), 'apps/papercusp-desktop/package.json'),
    join(process.cwd(), '../papercusp-desktop/package.json'),
    join(process.cwd(), '../../apps/papercusp-desktop/package.json'),
    join(process.cwd(), '../../../apps/papercusp-desktop/package.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8'));
        if (pkg?.version) return String(pkg.version);
      } catch {
        // ignore — try next candidate
      }
    }
  }
  return 'dev';
}
const appVersion = detectAppVersion();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  return NextResponse.json(
    {
      appVersion,
      sidecarSha,
      sidecarStartedAtMs: startedAtMs,
      nowMs: Date.now(),
      isDesktop: process.env.PAPERCUSP_DESKTOP === '1',
    },
    { headers: CORS_HEADERS },
  );
}
