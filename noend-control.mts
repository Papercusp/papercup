/*
 * TEMPORARY DIAGNOSTIC — P-002 / WI-1263402 "no-end control". DELETE AFTER USE.
 *
 * THE QUESTION: the BARE-PSU leg of the real-backend acceptance matrix reds with
 * "managed session died mid-launch-window". Two readings are live and the matrix
 * cannot distinguish them:
 *   (a) PRODUCT REGRESSION — an ordinary bare psu launch disturbs the managed
 *       session, killing it.
 *   (b) INTRINSIC — a managed codex session dies ~30s after launch on its own,
 *       whatever the test does, so the disturbance half is unmeasurable in ANY
 *       position and needs a different design.
 *
 * THE CONTROL: do EXACTLY what the matrix does up to and including SPAWN — PUI
 * create, server-side claim, run the pane argv under a pty — then do NOTHING.
 * No end command. No attach. No bare psu launch. Watch for ~2 minutes.
 *   dies at ~30s  => (b) intrinsic; the red is not about the bare launch.
 *   survives      => (a) the bare launch really is the disturbance.
 *
 * Motivating correction: adv_sessions.ended_by='self' is the DEGRADED DEFAULT
 * when end provenance was not captured (adv-session-ended-provenance.test.ts:199,
 * :222) — it is NOT evidence of a voluntary exit, and must not be read as one.
 */
import { openPuiSuSession } from './packages/operator-core/lib/launch-agent';
import {
  getAdvSession,
  markAdvSessionEnded,
  markAdvSessionLaunched,
} from './packages/operator-core/lib/adv-sessions';
import { managedSpawn } from './packages/operator-core/lib/task-manager/managed-spawn';

function shellQuote(argv: readonly string[]): string {
  return argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const BACKEND = (process.env.CONTROL_BACKEND || 'codex') as never;
const WATCH_MS = Number(process.env.CONTROL_WATCH_MS || 130_000);

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);
const log = (m: string) => console.log(`[+${el()}s] ${m}`);

/** The row's end-provenance fields, whatever they are named on the type. */
function endFields(row: unknown): Record<string, unknown> {
  const r = (row ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(r)) {
    if (/^(ended|exit|pid|sessionId|session_id|display|launchedAt|launched_at)/i.test(k)) {
      out[k] = r[k];
    }
  }
  return out;
}

async function main() {
  const opened = await openPuiSuSession({
    operation: 'create',
    backend: BACKEND,
    carry: 'warm',
    slug: 'papercusp',
  });
  if (!opened.ok) {
    console.log(`CREATE_REFUSED ${opened.error}`);
    process.exit(2);
  }
  const advSessionId = opened.session.advSessionId;
  log(`CREATE ok adv=${advSessionId}`);

  const row0 = await getAdvSession(advSessionId);
  const launchArgv = row0?.launchArgv ?? [];
  if (!launchArgv.length) {
    console.log('NO_LAUNCH_ARGV');
    process.exit(2);
  }
  log(`launchArgv[0]=${launchArgv[0]} argc=${launchArgv.length}`);

  const claimed = await markAdvSessionLaunched(advSessionId);
  log(`CLAIM launched_at stamped=${claimed}`);

  const ptyCommand = shellQuote(launchArgv);
  const spawned = await managedSpawn('script', ['-qfec', ptyCommand, '/dev/null'], {
    class: 'agent-session',
    title: `NO-END CONTROL — ${String(BACKEND)} adv:${advSessionId}`,
    argv: ['script', '-qfec', ptyCommand, '/dev/null'],
    harnessSlug: 'papercusp',
    launchedBy: 'diag:no-end-control',
    detail: { backend: BACKEND, advSessionId, control: 'no-end' },
  });
  const pid = spawned.child.pid ?? 0;
  log(`SPAWN pid=${pid}`);

  let captured = '';
  const cap = (c: Buffer | string) => {
    captured += String(c);
    if (captured.length > 16_000) captured = captured.slice(-16_000);
  };
  spawned.child.stdout?.on('data', cap);
  spawned.child.stderr?.on('data', cap);

  let childExit: { code: number | null; signal: string | null; atSec: number } | null = null;
  spawned.child.on('exit', (code, signal) => {
    childExit = { code, signal, atSec: Number(el()) };
    log(`CHILD EXIT code=${code} signal=${signal}`);
  });

  // ── THE CONTROL: from here on we send NOTHING and attach NOTHING. ──────────
  const samples: Record<string, unknown>[] = [];
  const deadline = Date.now() + WATCH_MS;
  let announcedEnd = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const row = await getAdvSession(advSessionId);
    const ef = endFields(row);
    const s = {
      t: Number(el()),
      spawnPidAlive: pidAlive(pid),
      rowPidAlive: pidAlive((row as { pid?: number } | null)?.pid),
      childExited: Boolean(childExit),
      ...ef,
    };
    samples.push(s);
    const endedAt = (ef.endedAt ?? ef.ended_at) as unknown;
    if (endedAt && !announcedEnd) {
      announcedEnd = true;
      log(`ROW ENDED t=${s.t}s ${JSON.stringify(ef)}`);
    }
    if (endedAt && childExit) break;
  }

  console.log('=== CONTROL RESULT ===');
  console.log(
    JSON.stringify(
      { advSessionId, backend: BACKEND, pid, childExit, watchMs: WATCH_MS, samples },
      null,
      1,
    ),
  );
  console.log('=== CHILD OUTPUT TAIL ===');
  console.log(captured.slice(-6000));

  try {
    if (pidAlive(pid)) process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  const final = await getAdvSession(advSessionId);
  if (final && !final.endedAt) {
    try {
      await markAdvSessionEnded(advSessionId, null, 'reconciler');
    } catch {
      /* may already be terminal */
    }
  }
  log('DONE');
  process.exit(0);
}

main().catch((e) => {
  console.error('CONTROL_ERROR', e);
  process.exit(3);
});
