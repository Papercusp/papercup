/**
 * How one agent session's process is started and accounted for, shared by the replay driver
 * (`load-driver.ts`) and the real-agent recorder (`record-session.ts`).
 *
 * Plan agent-capacity-and-cost-gcp-2026-09-30, P-004: the calibration compares a real session
 * with its replay, so both sides must be measured by the same code. Each session runs as its own
 * transient user service; a wrapper, still inside that cgroup, records `memory.peak` and
 * `cpu.stat usage_usec` for the CLI and every tool it spawned. (systemd-run's own "Memory peak"
 * summary line is read after the cgroup empties and was measured wrong by >100x on systemd 255,
 * so it is not used.)
 *
 * The copy and remove helpers SPAWN native cp/rm. Both callers run an HTTP server (the replay
 * server, or the recording proxy) on the same event loop as the sessions it serves, so a
 * synchronous copy of a 1.2 GB checkout starves every running agent's model traffic (first
 * load-driver smoke run: zero requests served while a second slot copied), and
 * fs.promises.cp walks the ~300k-file node_modules in JS at ~1.5 MB/s under load.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const STATS_MARKER = 'CAPDRV_CGROUP';

export type Isolation = 'systemd' | 'none';

export function runAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${err.slice(0, 500)}`))));
  });
}

export async function copyTree(src: string, dst: string): Promise<void> {
  mkdirSync(path.dirname(dst), { recursive: true });
  await runAsync('cp', ['-a', '--reflink=auto', src, dst]);
}

export const removeTree = (p: string): Promise<void> => runAsync('rm', ['-rf', '--', p]);

/** Parse the epilogue line the wrapper appends: `CAPDRV_CGROUP peak=<bytes> usage_usec=<n>`. */
export function parseCgroupStats(text: string): { memPeakBytes: number | null; cpuUsec: number | null } {
  const line = text.split('\n').reverse().find((l) => l.startsWith(STATS_MARKER));
  if (!line) return { memPeakBytes: null, cpuUsec: null };
  const num = (k: string) => {
    const m = new RegExp(`\\b${k}=(\\d+)`).exec(line);
    return m ? Number(m[1]) : null;
  };
  return { memPeakBytes: num('peak'), cpuUsec: num('usage_usec') };
}

/**
 * Wrap the CLI so the unit reports its own cgroup's peak memory and CPU before exiting, then
 * exits with the CLI's status. Runs inside `systemd-run`, so `/proc/self/cgroup` is the unit's.
 */
export function wrapperScript(statsFile: string): string {
  return [
    '"$@"',
    'rc=$?',
    'cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)',
    `printf '${STATS_MARKER} peak=%s usage_usec=%s\\n' "$(cat "$cg/memory.peak" 2>/dev/null)" "$(awk '/^usage_usec/{print $2}' "$cg/cpu.stat" 2>/dev/null)" >> "${statsFile}"`,
    'exit $rc',
  ].join('\n');
}

export function systemdRunArgs(unit: string, workDir: string, env: Record<string, string>, statsFile: string, argv: string[], slice = 'capdrv.slice'): string[] {
  const out = ['--user', '--wait', '--pipe', '--collect', '--quiet', `--unit=${unit}`, `--slice=${slice}`, `--working-directory=${workDir}`];
  // A multi-line value (an exported shell function, a pasted key) cannot pass through --setenv.
  for (const [k, v] of Object.entries(env)) if (!/[\n\r]/.test(v) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out.push(`--setenv=${k}=${v}`);
  out.push('bash', '-c', wrapperScript(statsFile), 'capdrv', ...argv);
  return out;
}

export interface SessionSpawn {
  cmd: string;
  args: string[];
  /** The env to hand spawn(): the session env itself, or (under systemd) the caller's, since the unit gets the session env through --setenv. */
  env: NodeJS.ProcessEnv;
  /** How to stop the session on timeout, besides signalling the spawned process group. */
  killArgs: string[] | null;
}

/**
 * The command that starts one session. Under `systemd` it is a transient unit `<unit>.service`
 * in `slice`; under `none` it is the CLI itself (no per-session accounting).
 */
export function sessionSpawn(
  isolation: Isolation,
  unit: string,
  workDir: string,
  env: Record<string, string>,
  statsFile: string,
  argv: string[],
  callerEnv: NodeJS.ProcessEnv,
  slice = 'capdrv.slice',
): SessionSpawn {
  if (isolation === 'systemd') {
    return {
      cmd: 'systemd-run',
      args: systemdRunArgs(unit, workDir, env, statsFile, argv, slice),
      env: callerEnv,
      killArgs: ['--user', 'kill', '--signal=SIGTERM', `${unit}.service`],
    };
  }
  return { cmd: argv[0], args: argv.slice(1), env, killArgs: null };
}
