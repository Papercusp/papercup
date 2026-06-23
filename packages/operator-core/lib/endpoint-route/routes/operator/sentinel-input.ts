/**
 * POST /api/operator/sentinel-input  { text: string }
 *
 * Voice-IN for the Sentinel-as-Claude-TUI (sentinel-as-claude-tui-2026-06-22,
 * Phase C). Writes a final STT transcript into the dock's 🛡 Sentinel pane's
 * stdin so the local user can talk to the Sentinel (a `psu --role=sentinel`
 * Claude-Code session) by voice. The webview voice runtime POSTs here instead
 * of routing into `operator:converse`.
 *
 * Mechanism: the Sentinel is the `focus=true` pane of the live `pui-dock-*`
 * zellij session; we `write-chars <text>` then `write 13` (Enter) to submit a
 * turn. (Verified manually that zellij write-chars reaches that pane.)
 *
 * LOCAL APP USER ONLY (owner constraint, 2026-06-22): this is the local
 * STT→pane pipeline, NOT the P2P voice-channel system. `auth: 'loopback'` — only
 * the local webview reaches it.
 *
 * v1 limitation: writes to the session's FOCUSED pane (the Sentinel by layout
 * default). If the user has focused another dock pane, the turn lands there —
 * a follow-up can focus the sentinel pane by id first.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';

const exec = promisify(execFile);

/** The operator may not carry ~/.cargo/bin on PATH; prefer the known location. */
function zellijBin(): string {
  const cargoBin = join(homedir(), '.cargo', 'bin', 'zellij');
  return existsSync(cargoBin) ? cargoBin : 'zellij';
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Resolve the live `pui-dock-*` zellij session (the agent dock), or null. */
async function resolveDockSession(): Promise<string | null> {
  try {
    const { stdout } = await exec(zellijBin(), ['ls'], { timeout: 4000 });
    for (const raw of stdout.split('\n')) {
      const line = raw.replace(ANSI, '');
      const m = line.match(/^(pui-dock-\S+)/);
      if (m && !/EXITED/.test(line)) return m[1];
    }
  } catch {
    /* zellij unavailable / no sessions */
  }
  return null;
}

interface Body {
  text?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/operator/sentinel-input',
  auth: 'loopback',
  async handler(req) {
    // CSRF guard: `auth: 'loopback'` admits the cookie-less webview, so it no
    // longer blocks a foreign browser page from POSTing to 127.0.0.1. This
    // endpoint types straight into the Sentinel's Claude-Code TUI stdin (an
    // RCE-adjacent sink), so a cross-origin write MUST be refused. Origin-based
    // (a browser always stamps it on a cross-origin request; JS can't forge it).
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;

    const body = (await req.json().catch(() => null)) as Body | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return Response.json({ error: 'text required' }, { status: 400 });

    const session = await resolveDockSession();
    if (!session) {
      return Response.json({ error: 'no live pui-dock session' }, { status: 503 });
    }

    const z = zellijBin();
    try {
      // `--` end-of-options marker: `text` is user-controlled, so without it a
      // value starting with `-` would be parsed as a zellij flag (argv flag
      // smuggling). After `--` everything is positional.
      await exec(z, ['-s', session, 'action', 'write-chars', '--', text], { timeout: 4000 });
      await exec(z, ['-s', session, 'action', 'write', '13'], { timeout: 4000 });
      return Response.json({ ok: true, session });
    } catch (e) {
      return Response.json(
        { error: `zellij write failed: ${String(e).slice(0, 200)}` },
        { status: 500 },
      );
    }
  },
});
