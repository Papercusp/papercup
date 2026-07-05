/**
 * operator-discovery.mjs — resolve the LIVE operator base URL for the
 * sidecar-shipped CLIs (onboard-launcher, tutorial-runner, ptool).
 *
 * A packaged desktop install runs its operator on a DYNAMICALLY-assigned
 * localhost port (re-picked on every boot) and records it in
 * ~/.papercusp/operator.json — the fixed :3070 exists only on the dev box.
 * Any CLI that defaults straight to :3070 dies with "can't reach the
 * Papercusp server at http://127.0.0.1:3070" on EVERY shipped install
 * (owner hit this live launching the tutorial on the seeded mac install,
 * 2026-07-05, WI-2903 thread). Same discovery convention as
 * psu-launcher.mjs `resolveOperatorUrl()` step 2 (WI-1457) — psu keeps its
 * own richer copy because it additionally probes the dev-box resilient
 * MCP proxy, which these CLIs never need.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The desktop operator's recorded address from ~/.papercusp/operator.json,
 * or null when the file is missing/unreadable (the dev box).
 */
export function discoverOperatorUrl({ home = homedir() } = {}) {
  try {
    const d = JSON.parse(readFileSync(join(home, '.papercusp', 'operator.json'), 'utf8'));
    if (d && typeof d.httpUrl === 'string' && d.httpUrl) return d.httpUrl;
    if (d && d.port) return `http://127.0.0.1:${d.port}`;
  } catch {
    /* no operator.json → not a packaged desktop install */
  }
  return null;
}

/**
 * Standard CLI precedence: explicit --operator-url arg → PAPERCUSP_OPERATOR_URL
 * env override → live desktop discovery (operator.json) → dev-box :3070.
 */
export function resolveOperatorBase(args = {}, env = process.env, opts = {}) {
  return (
    args.operatorUrl ??
    env.PAPERCUSP_OPERATOR_URL ??
    discoverOperatorUrl(opts) ??
    'http://127.0.0.1:3070'
  ).replace(/\/$/, '');
}
