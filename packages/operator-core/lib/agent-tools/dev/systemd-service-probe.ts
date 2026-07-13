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
  /** the service's current MainPID; 0 when systemd reports no live main process. */
  mainPid?: number;
  /** seconds since the current MainPID started; undefined when there is no live
   *  main process to measure (mainPid 0). */
  secondsSinceStart?: number;
}

export async function probeServiceStart(unit: string): Promise<ServiceStartInfo> {
  // Linux/systemd-only (a Windows desktop runs this sidecar under WSL, still
  // process.platform === 'linux', so it is NOT short-circuited — the try/catch
  // is the backstop for WSL-without-systemd).
  if (process.platform !== 'linux') return { ok: false };
  try {
    const svc = unit.endsWith('.service') ? unit : `${unit}.service`;
    const { stdout: pidOut } = await run(
      'systemctl',
      ['--user', 'show', '-p', 'MainPID', '--value', svc],
      { timeout: 3000 },
    );
    const mainPid = Number(pidOut.trim());
    // MainPID 0 ⇒ systemd has no live main process (down / never started). That
    // is a determinate answer: there is NO recent restart to coalesce against.
    if (!Number.isFinite(mainPid) || mainPid <= 0) return { ok: true, mainPid: 0 };
    const { stdout: etimesOut } = await run(
      'ps',
      ['-o', 'etimes=', '-p', String(mainPid)],
      { timeout: 3000 },
    );
    const etimes = Number(etimesOut.trim());
    if (!Number.isFinite(etimes) || etimes < 0) return { ok: true, mainPid };
    return { ok: true, mainPid, secondsSinceStart: etimes };
  } catch {
    return { ok: false };
  }
}
