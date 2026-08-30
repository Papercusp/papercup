/**
 * TEMPORARY PROBE (P-002 / EI-21908787009967815) — delete after use.
 *
 * ONE VARIABLE vs the no-end control (adv 21328, which sat READY and open for
 * 130.6s with nothing sent to it): this arm sends exactly ONE `\x03` through
 * interruptViaPty — the same call the matrix's INTERRUPT case makes — and then
 * watches whether the managed codex session stays up.
 *
 *   ARM=interrupt  → create, claim, run the pane argv, wait READY, send \x03, watch
 *   ARM=idle       → identical, but send NOTHING (re-runs the 21328 control)
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

process.env.PAPERCUSP_OPERATOR_BASE ||= 'http://127.0.0.1:3170';

const ARM = (process.env.ARM ?? 'interrupt') as 'interrupt' | 'idle';
const WATCH_MS = Number(process.env.WATCH_MS ?? 120_000);
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS ?? 90_000);

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid: number | null | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  const { openPuiSuSession } = await import('../packages/operator-core/lib/launch-agent');
  const { getAdvSession, markAdvSessionLaunched, markAdvSessionEnded } = await import(
    '../packages/operator-core/lib/adv-sessions'
  );
  const { interruptViaPty, findLiveHost } = await import(
    '../packages/operator-core/lib/events/await/psu-pty-discovery'
  );
  const { getOrgPg } = await import('@papercusp/db-org');

  const opened = await openPuiSuSession({
    operation: 'create',
    backend: 'codex',
    carry: 'warm',
    slug: 'papercusp',
  } as never);
  if (!(opened as { ok: boolean }).ok) {
    log('CREATE REFUSED', JSON.stringify(opened));
    return;
  }
  const advSessionId = (opened as { session: { advSessionId: number } }).session.advSessionId;
  log('created adv', advSessionId);

  const row0 = await getAdvSession(advSessionId);
  const argv = (row0 as { launchArgv?: string[] } | null)?.launchArgv ?? [];
  if (!argv.length) {
    log('NO launchArgv — abort');
    return;
  }

  // coord_owner_id is what psu-pty discovery keys on; the reader used by the
  // matrix drops columns (EI-21906395662385960), so read PG directly.
  const { sql } = getOrgPg();
  const [meta] = await sql`
    SELECT coord_owner_id, display FROM harness_shared.adv_sessions WHERE id = ${advSessionId}
  `;
  const ownerId = (meta as { coord_owner_id: string }).coord_owner_id;
  log('owner', ownerId, 'display', (meta as { display: string }).display);

  const claimed = await markAdvSessionLaunched(advSessionId);
  log('claimed launched_at:', claimed);

  const shellQuote = (a: string[]) => a.map((s) => `'${s.replaceAll("'", `'\\''`)}'`).join(' ');
  const child = spawn('script', ['-qfec', shellQuote(argv), '/dev/null'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pane = '';
  child.stdout?.on('data', (b) => {
    pane += String(b);
  });
  child.stderr?.on('data', (b) => {
    pane += String(b);
  });
  log('pane pid', child.pid);

  const tuiLog = `${process.env.HOME}/.papercusp/su-codex-homes/session-${advSessionId}/log/codex-tui.log`;
  const startedAt = Date.now();
  let ready = false;
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    await delay(2_000);
    // READY is the TUI's OWN startup line, not pane text: pane noise from psu's
    // bootstrap matched a text probe at 4s, ~27s before the TUI actually ran.
    if (existsSync(tuiLog) && /tui startup initial frame scheduled/.test(readFileSync(tuiLog, 'utf8'))) {
      ready = true;
      await delay(3_000);
      break;
    }
  }
  log('ready?', ready, 'after', Math.round((Date.now() - startedAt) / 1000), 's');
  log('host discovered?', findLiveHost(ownerId) != null);

  const rowBefore = await getAdvSession(advSessionId);
  log('before: endedAt', (rowBefore as { endedAt?: unknown } | null)?.endedAt ?? null);

  let injectedAt: number | null = null;
  if (ARM === 'interrupt') {
    const ok = await interruptViaPty(ownerId, 'sigint');
    injectedAt = Date.now();
    log('INTERRUPT injected (single \\x03):', ok);
  } else {
    log('IDLE arm — nothing sent');
  }

  const watchStart = Date.now();
  let died: number | null = null;
  while (Date.now() - watchStart < WATCH_MS) {
    await delay(2_000);
    const [r] = await sql`
      SELECT ended_at, ended_by, ended_signal, exit_code FROM harness_shared.adv_sessions
       WHERE id = ${advSessionId}
    `;
    const rr = r as { ended_at: Date | null; ended_by: string | null; ended_signal: string | null; exit_code: number | null };
    if (rr.ended_at) {
      died = Date.now();
      log(
        'ROW CLOSED after',
        Math.round((died - watchStart) / 1000),
        's of watch;',
        injectedAt ? `${Math.round((died - injectedAt) / 1000)}s after inject;` : '',
        JSON.stringify(rr),
      );
      break;
    }
  }
  if (!died) log('SURVIVED the whole', Math.round(WATCH_MS / 1000), 's watch; pane pid alive:', pidAlive(child.pid));

  if (existsSync(tuiLog)) {
    const tail = readFileSync(tuiLog, 'utf8').split('\n').filter((l) => /shutdown|panic|error/i.test(l));
    log('tui shutdown/error lines:', tail.length);
    for (const l of tail.slice(0, 4)) log('  ', l.slice(0, 200));
  }

  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  await markAdvSessionEnded(advSessionId, null, 'reconciler').catch(() => undefined);
  log('cleanup done for adv', advSessionId);
  process.exit(0);
}

void main();
