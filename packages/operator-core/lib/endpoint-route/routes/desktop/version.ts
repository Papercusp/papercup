/**
 * GET /api/desktop/version  (+ OPTIONS preflight)
 *
 * Returns minimal "what's running" info for the harness UI's bottom-right
 * pill — running version + sha, started-at, is-desktop. Used to detect
 * server restarts (sha change between polls → amber pill → click-to-reload).
 *
 * Ported from app/api/desktop/version/route.ts (Next handler) to the
 * endpoint-system framework — R1 pilot of endpoint-route-migration.
 * `auth: 'public'` preserves the original behavior (the route had no
 * auth); revisit in R5 if version info should be gated.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';

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
  if (process.env.PAPERCUSP_DESKTOP_VERSION) {
    return process.env.PAPERCUSP_DESKTOP_VERSION;
  }
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

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default [
  defineTool({
    method: 'GET',
    path: '/desktop/version',
    auth: 'public',
    handler() {
      return new Response(
        JSON.stringify({
          appVersion,
          sidecarSha,
          sidecarStartedAtMs: startedAtMs,
          nowMs: Date.now(),
          isDesktop: process.env.PAPERCUSP_DESKTOP === '1',
        }),
        { headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
      );
    },
  }),
  defineTool({
    method: 'OPTIONS',
    path: '/desktop/version',
    auth: 'public',
    handler() {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    },
  }),
];
