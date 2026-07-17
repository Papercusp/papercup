/**
 * Kernel-backed process identity for any code that is about to trust a PID
 * from durable state. A PID is only an address in the current process table;
 * pairing it with the boot id and process start time turns it into a stable
 * identity for the lifetime of that process.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Linux /proc stat field 22 (starttime), robust to spaces and ')' in comm. */
export function linuxStartTicksFromProcStat(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // Text after comm starts at field 3 (state); starttime is field 22 => index 19.
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ticks = fields[19];
  return ticks && /^\d+$/.test(ticks) ? ticks : null;
}

export function linuxProcessIdentityFromStat(bootId: string, stat: string): string | null {
  const boot = bootId.trim();
  const ticks = linuxStartTicksFromProcStat(stat);
  return boot && ticks ? `linux:${boot}:${ticks}` : null;
}

export function normalizePsStartTime(value: string): string {
  return value.trim().split(/\s+/).join(' ');
}

/**
 * Read the current identity of `pid`. Any read or parse failure returns null:
 * destructive callers must fail closed rather than fall back to PID-only.
 */
export function readProcessIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      return linuxProcessIdentityFromStat(
        readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFileSync(`/proc/${pid}/stat`, 'utf8'),
      );
    }
    if (process.platform === 'darwin') {
      const started = normalizePsStartTime(
        execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }),
      );
      return started ? `darwin:${started}` : null;
    }
  } catch {
    // Process exited, permissions changed, or this platform has no safe reader.
  }
  return null;
}
