/**
 * systemd-service-probe — read a `--user` service's REAL "how many seconds ago
 * did its MAIN process start", straight from the OS, for dev:restart's
 * coalesce-truth check (EI-11137).
 *
 * The bug this exists to kill: dev:restart's cooldown lock-marker alone is NOT
 * proof that a restart actually happened. A marker can be held while NO real
 * restart occurred — a withheld/failed restart, or a stale marker that on a
 * busy fleet is perpetually re-observed — and the old code returned
 * `coalesced:true` ("a peer already restarted it, probe directly") on pure
 * trust of that marker. Net effect: EVERY subsequent bg-host restart was
 * silently suppressed for the marker's TTL, so bg-host code fixes never went
 * live (it re-bundles the working tree ONLY on restart). We now cross-check the
 * marker against this ground truth before coalescing.
 *
 * Implementation: MainPID via `systemctl --user show`, elapsed seconds via
 * `ps -o etimes=`. That is robust across locales/TZ — unlike parsing systemd's
 * locale-formatted ExecMainStartTimestamp string — and is the same primitive
 * probeBgHostCodeDrift (service-health.ts) already relies on. Fail-soft: any
 * error, or a non-linux host, returns { ok:false } so the caller falls back to
 * marker-trust rather than crashing the restart path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ServiceStartInfo {
  /** false ⇒ could not determine (no systemd / non-linux / probe error) —
   *  the caller should fall back to trusting the lock marker. */
  ok: boolean;
  /** the service's current MainPID; 0 when systemd reports no live main process.
   *  Undefined for a unit TYPE that has no MainPID concept at all (a `.timer`
   *  — see `activeState` for that case). */
  mainPid?: number;
  /** seconds since the current MainPID started; undefined when there is no live
   *  main process to measure (mainPid 0 or absent). */
  secondsSinceStart?: number;
  /**
   * EI-18700974567040702: raw systemd `ActiveState`
   * (active/inactive/failed/activating/deactivating/reloading) — the UNIVERSAL
   * liveness signal, unlike `MainPID`: every systemd unit TYPE reports it,
   * including a `.timer` (which has no main process to report a PID for at
   * all — `systemctl show -p MainPID` simply OMITS that line for one, it is
   * not printed as `0`). Undefined only when `ok` is false.
   */
  activeState?: string;
}

/** systemd unit-type suffixes this probe recognizes as already-complete — anything
 *  else is assumed a bare service name and gets `.service` appended (the historical
 *  default `dev:restart`'s targets rely on). Recognizing `.timer` (and siblings) here
 *  matters: the OLD unconditional-unless-`.service` rule mangled
 *  `papercup-live-federation-gate.timer` into `papercup-live-federation-gate.timer.service`
 *  — a unit that does not exist, so systemctl silently reported MainPID=0 for a healthy,
 *  `active`/`waiting` timer, and nobody could see it because that same 0 was previously
 *  indistinguishable from a probe failure (the exact defect this file's other fix kills). */
const KNOWN_UNIT_SUFFIXES = /\.(service|timer|socket|target|mount|path|slice)$/;

export async function probeServiceStart(unit: string): Promise<ServiceStartInfo> {
  // Linux/systemd-only (a Windows desktop runs this sidecar under WSL, still
  // process.platform === 'linux', so it is NOT short-circuited — the try/catch
  // is the backstop for WSL-without-systemd).
  if (process.platform !== 'linux') return { ok: false };
  try {
    const svc = KNOWN_UNIT_SUFFIXES.test(unit) ? unit : `${unit}.service`;
    // KEY=VALUE lines, deliberately NOT `--value`: a property systemd considers
    // inapplicable to this unit's TYPE (MainPID on a `.timer`) is OMITTED from the
    // output entirely rather than printed empty — `--value`'s positional-only output
    // has no way to tell "omitted" apart from "the next requested property", so a
    // `.timer`'s single ActiveState line would misparse as if it were MainPID.
    const { stdout } = await run(
      'systemctl',
      ['--user', 'show', '-p', 'MainPID', '-p', 'ActiveState', svc],
      { timeout: 3000 },
    );
    const props = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      props.set(line.slice(0, eq), line.slice(eq + 1));
    }
    const activeState = props.get('ActiveState');
    const mainPidRaw = props.get('MainPID');
    if (mainPidRaw === undefined) {
      // No MainPID property for this unit type at all (e.g. a `.timer`) —
      // ActiveState is the only signal available, and on its own it is a
      // complete, determinate answer (a timer never has a "recent restart").
      return { ok: true, activeState };
    }
    const mainPid = Number(mainPidRaw);
    // MainPID 0 ⇒ systemd has no live main process (down / never started). That
    // is a determinate answer: there is NO recent restart to coalesce against.
    if (!Number.isFinite(mainPid) || mainPid <= 0) return { ok: true, mainPid: 0, activeState };
    const { stdout: etimesOut } = await run(
      'ps',
      ['-o', 'etimes=', '-p', String(mainPid)],
      { timeout: 3000 },
    );
    const etimes = Number(etimesOut.trim());
    if (!Number.isFinite(etimes) || etimes < 0) return { ok: true, mainPid, activeState };
    return { ok: true, mainPid, secondsSinceStart: etimes, activeState };
  } catch {
    return { ok: false };
  }
}
