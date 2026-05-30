/**
 * POST /api/adv/sessions/launch-su — in-app web launch of a tracked SU
 * session (P-020). The web equivalent of typing `psu` in a terminal:
 * server-spawns a terminal running `psu --no-picker --agent=… …`, which
 * records the adv_sessions row (via bootstrap-su) and exec's the matching
 * `*-su` wrapper. The session then appears in /adv Sessions via the live
 * poll — no sessionId returned synchronously (psu creates the row).
 *
 * Delegating to `psu` (rather than re-deriving the envelope + spawning a
 * wrapper here) keeps a single source of truth for the launch flow.
 *
 * Linux-only server-side spawn, mirroring console-launch.ts. Same-origin
 * (the /adv UI is served by the operator) — no CORS preamble needed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineTool } from '@papercusp/agent-mcp';
import { isSuAgent } from '@/lib/su-agents';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Minimal terminal finder — mirrors console-launch.ts's LINUX_TERMINALS.
const LINUX_TERMINALS: Array<[string, string[]]> = [
  ['gnome-terminal', ['--wait', '--window', '--']],
  ['konsole', ['--new-window', '-e']],
  ['xfce4-terminal', ['--window', '-e']],
  ['alacritty', ['-e']],
  ['kitty', ['--']],
  ['wezterm', ['start', '--always-new-process', '--']],
  ['xterm', ['-e']],
];

function isOnPath(bin: string): boolean {
  const paths = (process.env.PATH ?? '').split(':');
  paths.push('/usr/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'));
  return paths.some((p) => p && existsSync(join(p, bin)));
}

function findTerminal(): { bin: string; args: string[] } | null {
  const fromEnv = process.env.TERMINAL;
  if (fromEnv && isOnPath(fromEnv)) {
    return fromEnv === 'gnome-terminal' ? { bin: fromEnv, args: ['--wait', '--'] } : { bin: fromEnv, args: ['-e'] };
  }
  for (const [bin, args] of LINUX_TERMINALS) {
    if (isOnPath(bin)) return { bin, args: [...args] };
  }
  return null;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const launchSu = defineTool({
  method: 'POST',
  path: '/adv/sessions/launch-su',
  auth: 'public',
  async handler(req) {
    let body: { agent?: string; harness_slug?: string | null; plan_slug?: string | null } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      return json({ status: 'error', error: 'invalid JSON body' }, 400);
    }

    if (!isSuAgent(body.agent)) {
      return json({ status: 'error', error: 'agent must be one of claude|omp|codex' }, 400);
    }
    const agent = body.agent;
    const harness = body.harness_slug?.trim() || null;
    const plan = body.plan_slug?.trim() || null;
    if (harness && !SLUG_RE.test(harness)) return json({ status: 'error', error: 'invalid harness slug' }, 400);
    if (plan && !SLUG_RE.test(plan)) return json({ status: 'error', error: 'invalid plan slug' }, 400);

    if (process.platform !== 'linux') {
      return json({ status: 'error', error: 'server-side spawn only implemented for Linux' }, 501);
    }

    const psuPath = join(homedir(), '.local', 'bin', 'psu');
    const psuRef = existsSync(psuPath) ? psuPath : 'psu';
    if (psuRef === 'psu' && !isOnPath('psu')) {
      return json(
        {
          status: 'error',
          code: 'psu_not_installed',
          error: '`psu` not found on PATH — run apps/operator/scripts/install-standalone-mcp.sh',
        },
        200,
      );
    }

    const term = findTerminal();
    if (!term) {
      return json(
        { status: 'error', error: 'no terminal emulator found. Set $TERMINAL or install gnome-terminal / alacritty / kitty / xterm' },
        500,
      );
    }

    // All tokens are fixed flags or validated slugs; shellEscape is
    // belt-and-suspenders against a future un-validated field.
    const psuArgs = [psuRef, '--no-picker', `--agent=${agent}`];
    if (harness) psuArgs.push(`--harness=${harness}`);
    psuArgs.push(plan ? `--plan=${plan}` : '--no-plan');
    const oneliner = `exec ${psuArgs.map(shellEscape).join(' ')}`;

    try {
      const child = spawn(term.bin, [...term.args, 'bash', '-lc', oneliner], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
      return json({ status: 'ok', agent, harnessSlug: harness, planSlug: plan, terminal: term.bin, pid: child.pid });
    } catch (e: any) {
      return json({ status: 'error', error: `spawn ${term.bin} failed: ${e?.message}` }, 500);
    }
  },
});

export default [launchSu];
