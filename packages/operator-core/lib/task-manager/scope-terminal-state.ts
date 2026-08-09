/**
 * task-manager/scope-terminal-state — the impure half of D-018
 * (task-manager-no-escape-2026-07-27): ask systemd directly whether a transient
 * task scope has been released, so `reconcile.ts` (kept PURE by construction, see
 * its header) never has to.
 *
 * `reconcile.ts`'s own kernel scan cannot distinguish "scope absent from the scan"
 * from "scope exists but empty" — its `byScope` index is built from a process
 * scan, so a released scope and a merely-empty one look identical. systemd's own
 * cgroup-emptiness tracking is the authority the whole no-escape property already
 * rests on (every scope is `systemd-run --user --scope`), so asking it directly
 * settles the question a process scan structurally cannot.
 *
 * ⚠ Do NOT reuse this to key SUCCESS on `ActiveState` for a `systemctl stop` you
 * issued yourself — `terminal-residue-census.ts` documents why that specific
 * pattern is unsound for a scope with `KillMode=process` (a stop can flip the
 * unit to inactive while leaving every process in its cgroup running). That
 * caution does not apply here: this module never stops anything, and every scope
 * `managedSpawn` creates (`buildTaskScopeArgv`) uses systemd's default
 * `KillMode=control-group` for `.scope` units — no call site overrides it — so an
 * `ActiveState` this module did not itself induce really does mean the cgroup
 * emptied on its own.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Injectable for tests — same shape `node:util`'s promisified `execFile` returns. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** ActiveState values that mean "still alive" — everything else (inactive,
 *  failed, or the unit having been garbage-collected entirely, which `systemctl
 *  show` reports as `inactive` for an unknown unit) counts as released. */
const LIVE_ACTIVE_STATES = new Set(['active', 'activating', 'reloading', 'deactivating']);

/**
 * For each of `units` (systemd `--user` scope unit names), ask systemd whether it
 * is still active. Returns the subset CONFIRMED released.
 *
 * Fails soft to an EMPTY set on any error (no `systemctl` binary, no user bus, a
 * non-Linux host, a timeout) — the caller then falls back to the pre-D-018
 * behavior (strand it) rather than ever fabricating a release. One batched call
 * covers the whole candidate list: `systemctl show` accepts multiple unit
 * operands and prints one `ActiveState=<value>` line per unit, in argument order.
 */
export async function checkScopesReleased(
  units: readonly string[],
  execFn: ExecFileFn = execFileAsync,
): Promise<ReadonlySet<string>> {
  const released = new Set<string>();
  if (units.length === 0 || process.platform !== 'linux') return released;

  try {
    const { stdout } = await execFn('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', ...units], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    // `--value` with multiple units prints exactly one line per unit, in order,
    // plus a trailing newline. Guard the count mismatch rather than trust it
    // blindly: a systemd that changed its output shape should degrade to
    // "nothing confirmed", never to a misaligned unit<->state pairing.
    const lines = stdout.split('\n');
    const values = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    if (values.length !== units.length) return released;
    for (let i = 0; i < units.length; i++) {
      const state = (values[i] ?? '').trim();
      if (state.length > 0 && !LIVE_ACTIVE_STATES.has(state)) released.add(units[i]!);
    }
  } catch {
    // systemctl missing, no bus, timeout, non-zero exit for an unknown unit on
    // some systemd versions — any of these means "could not confirm", not
    // "confirmed released". Fail soft: an empty set never loses a genuine escape,
    // it only means D-018's split does not fire for this tick.
  }
  return released;
}
