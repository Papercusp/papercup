/**
 * POST /api/adv/sessions/launch-pui — open the `pui` ratatui workbench
 * (apps/tui) in an OS-native terminal. The desktop equivalent of typing
 * `pui workbench`: the operator host (which on the desktop runs inside the
 * user's GUI session) server-spawns a terminal running `pui workbench`, which
 * materializes the zellij workbench layout and connects to the live operator
 * over endpoint-IPC (~/.papercusp/endpoint-ipc.json) — no args/env needed.
 *
 * Mirrors launch-su.ts: Linux-only server-side spawn via the shared
 * `terminal-spawn` helper (D-001). Same-origin (the header that calls this is
 * served by the operator) — no CORS preamble needed.
 *
 * Plan: desktop-pui-launch-button-2026-06-05 (Brief 26).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineTool } from '@papercusp/agent-mcp';
import { isOnPath, shellEscape, spawnInTerminal } from '../../../terminal-spawn';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Resolve the `pui` binary. It installs to `~/.cargo/bin/pui`, which the
 * shared isOnPath() does NOT probe — so check the cargo + local bins
 * explicitly, then fall back to a bare `pui` on PATH (D-003).
 */
function resolvePuiBin(): string | null {
  const candidates = [
    join(homedir(), '.cargo', 'bin', 'pui'),
    join(homedir(), '.local', 'bin', 'pui'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return isOnPath('pui') ? 'pui' : null;
}

const launchPui = defineTool({
  method: 'POST',
  path: '/adv/sessions/launch-pui',
  auth: 'public',
  async handler() {
    if (process.platform !== 'linux') {
      return json({ status: 'error', error: 'server-side spawn only implemented for Linux' }, 501);
    }

    const puiBin = resolvePuiBin();
    if (!puiBin) {
      return json(
        {
          status: 'error',
          code: 'pui_not_installed',
          error: '`pui` not found — install the TUI workbench (cd apps/tui && cargo install --path .)',
        },
        200,
      );
    }

    // `pui workbench` materializes the zellij layout + connects over
    // endpoint-IPC; no args/env needed. `bash -lc` (login shell, inside
    // spawnInTerminal) puts ~/.cargo/bin on PATH so pui's own `zellij` spawn
    // resolves. `puiBin` is a fixed resolved path — shellEscape guards it.
    const oneliner = `exec ${shellEscape(puiBin)} workbench`;
    const spawned = spawnInTerminal({ oneliner, env: process.env });
    if (!spawned.ok) {
      return json({ status: 'error', error: spawned.error }, 500);
    }
    return json({ status: 'ok', terminal: spawned.terminal, pid: spawned.pid });
  },
});

export default [launchPui];
