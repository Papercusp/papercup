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
import type { TaskTerminalProvenance } from './types';

let execFileAsyncImpl: ((...args: any[]) => Promise<any>) | undefined;
const execFileAsync = (...args: any[]) => (execFileAsyncImpl ??= promisify(execFile) as any)(...args);

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
 * Align `systemctl show -p <one-property> --value <u1> <u2> ...` output to its unit
 * operands, or return `null` when the shape is not one we recognise.
 *
 * ⚠ WI-38163. systemd separates per-unit blocks with a BLANK line, so requesting a
 * single property for N units yields **2N-1** lines (value, '', value, '', value),
 * NOT N. The original implementation asserted one-line-per-unit and guarded the
 * mismatch by bailing out — which meant the guard fired on EVERY real multi-unit
 * call and D-018's stranded/ended_unobserved split silently never fired except for
 * a tick with exactly one candidate. Measured before the fix: 740 `stranded` vs 258
 * `ended_unobserved` sidecar rows, ~74% of routine shutdowns filed as escapes.
 *
 * The one-line-per-unit shape is still accepted, because N=1 is genuinely that shape
 * and a future systemd could drop the separator. Anything else returns `null` so the
 * caller keeps failing soft — never a misaligned unit<->state pairing.
 */
export function parseActiveStateValues(stdout: string, unitCount: number): string[] | null {
  if (unitCount <= 0) return null;
  const lines = stdout.split('\n');
  const trimmed = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;

  // One line per unit — the N=1 case, and any systemd that omits the separator.
  if (trimmed.length === unitCount) return trimmed;

  // Blank-separated blocks: values at even indices, separators at odd ones.
  if (unitCount > 1 && trimmed.length === unitCount * 2 - 1) {
    for (let i = 1; i < trimmed.length; i += 2) {
      // A non-blank separator means this is not the shape we think it is.
      if ((trimmed[i] ?? '').trim() !== '') return null;
    }
    const values: string[] = [];
    for (let i = 0; i < trimmed.length; i += 2) values.push(trimmed[i] ?? '');
    return values;
  }

  return null;
}

/**
 * For each of `units` (systemd `--user` scope unit names), ask systemd whether it
 * is still active. Returns the subset CONFIRMED released.
 *
 * Fails soft to an EMPTY set on any error (no `systemctl` binary, no user bus, a
 * non-Linux host, a timeout) — the caller then falls back to the pre-D-018
 * behavior (strand it) rather than ever fabricating a release. One batched call
 * covers the whole candidate list; see `parseActiveStateValues` for the output
 * shape, which is NOT one line per unit.
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
    // Shape handling lives in `parseActiveStateValues` (WI-38163) — a `null` there
    // means "could not align", which degrades to "nothing confirmed" rather than to
    // a misaligned unit<->state pairing.
    const values = parseActiveStateValues(stdout, units.length);
    if (!values) return released;
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

const TERMINAL_SHOW_PROPERTIES = [
  'Id',
  'LoadState',
  'ActiveState',
  'Result',
  'ExecMainCode',
  'ExecMainStatus',
  'MemoryMax',
  'MemoryPeak',
  'ControlGroup',
  'InvocationID',
] as const;

function terminalInteger(raw: string | undefined): number | null {
  if (!raw || raw === 'infinity' || raw === '[not set]') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function terminalText(raw: string | undefined): string | null {
  return raw && raw.length > 0 && raw !== '[not set]' ? raw : null;
}

/**
 * Parse `systemctl show` property blocks by their explicit `Id`, never by row
 * position. systemd separates multiple units with blank lines and omits
 * properties unsupported by a unit kind, so a positional N-properties-times-N
 * parser silently shifts fields as soon as a `.scope` lacks ExecMainStatus.
 */
export function parseTaskUnitTerminalSnapshots(
  stdout: string,
  requestedUnits: readonly string[],
  capturedAt = new Date().toISOString(),
): ReadonlyMap<string, TaskTerminalProvenance> {
  const requested = new Set(requestedUnits);
  const found = new Map<string, TaskTerminalProvenance>();
  for (const block of stdout.trim().split(/\n\s*\n/)) {
    if (!block.trim()) continue;
    const properties = new Map<string, string>();
    for (const line of block.split('\n')) {
      const equal = line.indexOf('=');
      if (equal <= 0) continue;
      properties.set(line.slice(0, equal), line.slice(equal + 1));
    }
    const scopeUnit = properties.get('Id');
    if (!scopeUnit || !requested.has(scopeUnit)) continue;
    const loadState = terminalText(properties.get('LoadState'));
    const unitNotFound = loadState === 'not-found';
    const peakMemoryBytes = terminalInteger(properties.get('MemoryPeak'));
    found.set(scopeUnit, {
      capturedAt,
      scopeUnit,
      // An unknown/collected unit can report default values for every queried
      // property. Keep only the release identity/state; none of those defaults
      // are terminal evidence from the task that used to own this unit.
      cgroupPath: unitNotFound ? null : terminalText(properties.get('ControlGroup')),
      invocationId: unitNotFound ? null : terminalText(properties.get('InvocationID')),
      loadState,
      activeState: terminalText(properties.get('ActiveState')),
      // `systemctl show` fabricates Result=success for an unknown/collected unit.
      // A not-found unit proves release, but it carries NO terminal verdict.
      serviceResult: unitNotFound ? null : terminalText(properties.get('Result')),
      execMainCode: unitNotFound ? null : terminalInteger(properties.get('ExecMainCode')),
      execMainStatus: unitNotFound ? null : terminalInteger(properties.get('ExecMainStatus')),
      memoryMaxBytes: unitNotFound ? null : terminalInteger(properties.get('MemoryMax')),
      peakMemoryBytes: unitNotFound ? null : peakMemoryBytes,
      peakMemorySource: unitNotFound || peakMemoryBytes == null ? 'unknown' : 'systemd',
    });
  }
  return found;
}

/**
 * Snapshot the terminal properties a failed transient unit loses at
 * `reset-failed`. Fails soft to an empty map: absence of evidence must never be
 * converted into an OOM/timeout verdict.
 */
export async function inspectTaskUnitTerminals(
  units: readonly string[],
  execFn: ExecFileFn = execFileAsync,
  now: () => Date = () => new Date(),
): Promise<ReadonlyMap<string, TaskTerminalProvenance>> {
  if (units.length === 0 || process.platform !== 'linux') return new Map();
  try {
    const { stdout } = await execFn(
      'systemctl',
      ['--user', 'show', '--no-pager', `--property=${TERMINAL_SHOW_PROPERTIES.join(',')}`, ...units],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    return parseTaskUnitTerminalSnapshots(stdout, units, now().toISOString());
  } catch {
    return new Map();
  }
}

const MANAGED_TASK_UNIT = /^pc-[0-9a-z]{4,64}(?:--[A-Za-z0-9._-]{1,60})?\.(?:scope|service)$/;

/**
 * Release one failed task unit only AFTER its terminal snapshot is durable.
 * Successful/inactive units are garbage-collected by systemd without help.
 */
export async function resetFailedTaskUnit(
  terminal: TaskTerminalProvenance,
  execFn: ExecFileFn = execFileAsync,
): Promise<boolean> {
  if (
    process.platform !== 'linux' ||
    terminal.activeState !== 'failed' ||
    terminal.loadState !== 'loaded' ||
    !MANAGED_TASK_UNIT.test(terminal.scopeUnit)
  ) {
    return false;
  }
  try {
    await execFn('systemctl', ['--user', 'reset-failed', terminal.scopeUnit], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch {
    // The reconciler will re-read and retry a still-loaded failed unit. Cleanup
    // failure must never overwrite the task verdict we already persisted.
    return false;
  }
}
