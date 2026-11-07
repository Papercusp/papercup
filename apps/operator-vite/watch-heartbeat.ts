/**
 * Dev-watch build heartbeat (EI-5202).
 *
 * Why this exists
 * ---------------
 * `vite build --watch` (bin/vite-watch-singleton) can silently STOP rebuilding
 * while its process tree stays alive — the flock the singleton holds never
 * releases, so nothing signals death, but no new build ever lands in `dist/`.
 * A dev fix a fleet member landed + committed then looks like it "isn't
 * deploying" on :3270/:3055, with the only diagnostic being to manually `stat`
 * `dist/index.html` against the edit time and `pgrep` the watcher tree — this
 * has cost real debugging hours (a watcher was observed wedged for 6.5 days
 * with zero signal).
 *
 * The cure: after every successful rebuild (the initial build AND every watch
 * rebuild — `writeBundle` fires for both), stamp a small heartbeat file with
 * the build time + the git SHA `dist/` was built from. A health probe /
 * VersionBadge can then compare this heartbeat's age (or its SHA vs
 * `git rev-parse HEAD`) to flag "dev dist STALE (watcher wedged)" instead of
 * requiring a human to notice and manually diagnose it. This plugin only
 * WRITES the signal; wiring up a consumer (a probe endpoint / status-bar
 * surface) is a separate follow-up — see EI-5202 for the full suggested design
 * (self-healing restart, dev_wrapper.rs status-bar surfacing).
 *
 * The path + payload construction are pure functions so they are unit-tested
 * without spinning up a real Vite build; the plugin is the thin disk glue.
 */
import type { Plugin } from 'vite';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { managedSetInterval, type ManagedHandle } from '../../libs/generic/scheduled-registry/src/index';

const DEFAULT_LOCK_PATH = '/tmp/papercup-operator-vite-watch.lock';

/**
 * Resolve the heartbeat file path. `VITE_WATCH_HEARTBEAT` overrides outright;
 * otherwise it rides alongside the watch-singleton's own lock file
 * (`VITE_WATCH_LOCK`, same default as bin/vite-watch-singleton) so both halves
 * of the EI-306/EI-5202 mechanism agree on one well-known location without
 * duplicating the default path in two places.
 */
export function resolveHeartbeatPath(env: Record<string, string | undefined>): string {
  if (env.VITE_WATCH_HEARTBEAT && env.VITE_WATCH_HEARTBEAT.trim()) return env.VITE_WATCH_HEARTBEAT;
  const lock = env.VITE_WATCH_LOCK && env.VITE_WATCH_LOCK.trim() ? env.VITE_WATCH_LOCK : DEFAULT_LOCK_PATH;
  return `${lock}.heartbeat`;
}

export interface HeartbeatPayload {
  /** ms epoch of this rebuild — the primary staleness signal (compare to now). */
  builtAtMs: number;
  /** Same instant, human-readable. */
  builtAt: string;
  /** The git SHA `dist/` was built from, or null when unresolvable (never fatal). */
  gitSha: string | null;
}

/** Pure: build the heartbeat payload. No disk/clock/git access — callers resolve those. */
export function buildHeartbeatPayload(nowMs: number, gitSha: string | null): HeartbeatPayload {
  return { builtAtMs: nowMs, builtAt: new Date(nowMs).toISOString(), gitSha };
}

/** Best-effort HEAD SHA for `cwd` — never throws (a dirty/missing git state must not fail the build). */
export function resolveGitShaBestEffort(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Watch builds retain their completion file. One-shot builds report lifecycle
 * boundaries and periodic progress into the caller's existing build log. A
 * deadline after "modules transformed" otherwise hides whether linking,
 * rendering, or output hooks were reached (EI-28171117618903276).
 */
export function watchHeartbeatPlugin(): Plugin {
  let active = false;
  let root = process.cwd();
  let log: (line: string) => void = () => {};
  let timer: ManagedHandle | undefined;
  let phase = 'build-start';
  let startedAt = 0;
  let phaseStartedAt = 0;
  let startedCpu = process.cpuUsage();
  const stop = () => {
    timer?.stop();
    timer = undefined;
  };
  const report = (event: 'phase' | 'progress') => {
    const now = performance.now();
    const cpu = process.cpuUsage(startedCpu);
    log(`[vite-build-progress] ${JSON.stringify({
      event, phase, pid: process.pid,
      elapsedMs: Math.round(now - startedAt),
      phaseElapsedMs: Math.round(now - phaseStartedAt),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
    })}`);
  };
  const enter = (next: string) => {
    if (active) return;
    phase = next;
    phaseStartedAt = performance.now();
    report('phase');
  };
  return {
    name: 'papercusp-watch-heartbeat',
    apply: 'build',
    configResolved(config) {
      active = Boolean(config.build.watch);
      root = config.root;
      log = (line) => config.logger.info(line);
    },
    buildStart() {
      stop();
      if (active) return;
      startedAt = performance.now();
      startedCpu = process.cpuUsage();
      enter('build-start');
      timer = managedSetInterval('vite-build-progress', 30_000, () => report('progress'), {
        category: 'external-process', classification: 'must-sample', instanced: true,
      });
    },
    buildEnd(error) {
      enter(error ? 'build-error' : 'build-end');
      if (error) stop();
    },
    renderStart() {
      enter('render-start');
    },
    generateBundle: {
      order: 'post',
      handler() { enter('generate-end'); },
    },
    renderError() {
      enter('render-error');
      stop();
    },
    async writeBundle() {
      if (!active) {
        enter('write-end');
        return;
      }
      const path = resolveHeartbeatPath(process.env);
      const payload = buildHeartbeatPayload(Date.now(), resolveGitShaBestEffort(root));
      try {
        await writeFile(path, JSON.stringify(payload, null, 2));
      } catch {
        // Best-effort — a heartbeat write failure (e.g. /tmp unwritable) must
        // never fail the actual rebuild it is reporting on.
      }
    },
    closeBundle() {
      enter('close');
      stop();
    },
  };
}
