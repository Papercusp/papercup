/**
 * POST /api/operator/sentinel-input  { text: string }
 *
 * Voice-IN for the Sentinel-as-Claude-TUI (sentinel-as-claude-tui-2026-06-22,
 * Phase C). Writes a final STT transcript into the dock's 🛡 Sentinel pane's
 * stdin so the local user can talk to the Sentinel (a `psu --role=sentinel`
 * Claude-Code session) by voice. The webview voice runtime POSTs here instead
 * of routing into `operator:converse`.
 *
 * Mechanism: `psu-sentinel` registers the Sentinel pane's zellij id at launch to
 * ~/.papercusp/sentinel-pane; we `write-chars --pane-id <sentinel> <text>` then
 * `write --pane-id <sentinel> 13` (Enter) to submit a turn — so it always lands
 * in the SENTINEL pane, not whatever pane is focused. (Verified: a `--pane-id`
 * write reaches the sentinel composer, not the focused pane.) If the
 * registration is absent/stale we fall back to the live session's focused pane.
 *
 * LOCAL APP USER ONLY (owner constraint, 2026-06-22): this is the local
 * STT→pane pipeline, NOT the P2P voice-channel system. `auth: 'loopback'` — only
 * the local webview reaches it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';

const exec = promisify(execFile);

/**
 * How long after the Sentinel pane registers (launch start) to treat it as still
 * "warming up" — psu bootstrap + Claude TUI boot before the composer accepts
 * input. A voice-in inside this window is delayed (not dropped) so it lands in a
 * ready composer. Sized to cover a typical psu+claude cold boot on the dev box.
 */
const SENTINEL_WARMUP_MS = 8000;

/** The operator may not carry ~/.cargo/bin on PATH; prefer the known location. */
function zellijBin(): string {
  const cargoBin = join(homedir(), '.cargo', 'bin', 'zellij');
  return existsSync(cargoBin) ? cargoBin : 'zellij';
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * True when a `dump-screen` shows a zellij command pane whose process has
 * EXITED and is "held" at the re-run prompt (e.g. the Sentinel's psu/Claude
 * session crashed or quit). zellij renders that held frame with a distinctive
 * footer — `<ENTER> re-run … Ctrl-c exit [ EXIT CODE: N ] EXITED`. Writing into
 * such a pane is harmful: `write-chars` goes nowhere useful and the trailing
 * Enter (`write 13`) TRIGGERS the re-run, spawning a fresh session AND losing the
 * voice turn. So voice-in detects this and refuses rather than silently dropping
 * the user's words into a re-run. Requires BOTH `EXIT CODE:` and a `re-run` hint
 * so ordinary chat content mentioning "exit code" can't false-positive.
 */
export function isExitedPaneScreen(dump: string): boolean {
  const clean = dump.replace(ANSI, '');
  return /EXIT CODE:/i.test(clean) && /re-?run/i.test(clean);
}

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

/**
 * Read the Sentinel pane registration that `psu-sentinel` writes at launch
 * ("<session> <paneId>"), so we can write to the Sentinel pane specifically via
 * `--pane-id` instead of whatever pane is focused. null if absent/malformed.
 */
function readSentinelPaneReg(): { session: string; paneId: string } | null {
  try {
    const raw = readFileSync(join(homedir(), '.papercusp', 'sentinel-pane'), 'utf8').trim();
    const sp = raw.indexOf(' ');
    if (sp <= 0) return null;
    const session = raw.slice(0, sp).trim();
    const paneId = raw.slice(sp + 1).trim();
    return session && paneId ? { session, paneId } : null;
  } catch {
    return null;
  }
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

    // Prefer the registered Sentinel pane (psu-sentinel writes it at launch) so
    // we type into the SENTINEL pane, not whatever pane is focused. The dock is
    // volatile, so only trust the registration if its session is the live one;
    // otherwise fall back to the focused pane of the live session.
    const reg = readSentinelPaneReg();
    const paneId = reg && reg.session === session ? reg.paneId : null;

    // Boot-window guard (dock-relaunch race). `psu-sentinel` writes the
    // registration at launch START, then psu bootstraps + the Claude TUI boots
    // for several seconds before its composer accepts input. The dock is
    // volatile — it relaunches (new pui-dock session) and the pane's psu process
    // restarts — so a voice-in that lands in that warm-up window is typed into a
    // not-yet-ready composer and SILENTLY LOST (observed in the 2026-06-23 live
    // test: the first utterance vanished because the dock had just relaunched).
    // When the registration is very fresh the pane is still warming up, so wait
    // out the remaining warm-up before writing. The turn is delayed a few seconds
    // (only right after a relaunch) instead of dropped. Bounded; stat failure or
    // a stale (focused-pane) fallback skips the gate.
    if (paneId) {
      try {
        const ageMs = Date.now() - statSync(join(homedir(), '.papercusp', 'sentinel-pane')).mtimeMs;
        if (ageMs >= 0 && ageMs < SENTINEL_WARMUP_MS) {
          await new Promise((r) => setTimeout(r, SENTINEL_WARMUP_MS - ageMs));
        }
      } catch {
        /* stat unavailable — proceed without the warm-up gate */
      }
    }

    const z = zellijBin();

    // Exited-pane guard: if the registered pane is HELD at zellij's re-run prompt
    // (its psu/Claude command exited — crash or quit), do NOT write. `write-chars`
    // would go nowhere useful and the trailing Enter (`write 13`) would TRIGGER
    // the re-run — spawning a fresh session AND silently losing this turn. Refuse
    // explicitly (409 `exited:true`) so the caller can surface "Sentinel is
    // restarting" / retry instead of dropping the user's words into a re-run. Only
    // for the registered pane; best-effort (a dump failure falls through to write).
    if (paneId) {
      try {
        const { stdout } = await exec(
          z,
          ['-s', session, 'action', 'dump-screen', '--pane-id', paneId],
          { timeout: 4000 },
        );
        if (isExitedPaneScreen(stdout)) {
          return Response.json(
            { error: 'sentinel pane exited (held at re-run prompt); not writing', exited: true, session, paneId },
            { status: 409 },
          );
        }
      } catch {
        /* dump unavailable — proceed with the write (best-effort guard) */
      }
    }

    try {
      // `--` end-of-options marker: `text` is user-controlled, so without it a
      // value starting with `-` would be parsed as a zellij flag (argv flag
      // smuggling). After `--` everything is positional.
      if (paneId) {
        await exec(z, ['-s', session, 'action', 'write-chars', '--pane-id', paneId, '--', text], { timeout: 4000 });
        await exec(z, ['-s', session, 'action', 'write', '--pane-id', paneId, '13'], { timeout: 4000 });
      } else {
        await exec(z, ['-s', session, 'action', 'write-chars', '--', text], { timeout: 4000 });
        await exec(z, ['-s', session, 'action', 'write', '13'], { timeout: 4000 });
      }
      return Response.json({ ok: true, session, paneId, targeted: !!paneId });
    } catch (e) {
      return Response.json(
        { error: `zellij write failed: ${String(e).slice(0, 200)}` },
        { status: 500 },
      );
    }
  },
});
