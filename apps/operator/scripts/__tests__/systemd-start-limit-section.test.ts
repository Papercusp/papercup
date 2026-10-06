import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * WI-10006428 — recurrence guard for a bug CLASS: start-limit keys in the wrong section.
 *
 * WHAT WENT WRONG. papercusp-mac-vm-gateway-tunnel.service set `StartLimitIntervalSec=0`
 * under [Service]. systemd only honours StartLimitIntervalSec / StartLimitBurst /
 * StartLimitAction in [Unit]; in [Service] it logs "Unknown key" at load and IGNORES the
 * line, so the unit silently ran with the 10s/5 default instead of the "never stop
 * re-dialing" policy its comment promised. Nothing failed: the unit loaded, started and
 * reported active, and the only trace was one journal line at daemon-reload. It surfaced
 * only because `systemd-analyze --user verify` was run for an unrelated unit (WI-10006342).
 *
 * WHY A TEST. The wrong section is invisible in a review of the key itself — the line
 * reads correctly — and the failure mode is "your setting has no effect", which no
 * runtime surface reports. So every tracked unit and drop-in here is parsed, and any
 * start-limit key outside [Unit] fails the build.
 */

const SYSTEMD_DIR = process.env.SYSTEMD_START_LIMIT_DIR ?? resolve(__dirname, '..', 'systemd');

const UNIT_FILE = /\.(service|service\.in|socket|timer|path|target|mount|conf)$/;
const START_LIMIT_KEY = /^(StartLimitIntervalSec|StartLimitInterval|StartLimitBurst|StartLimitAction)\s*=/;

interface Misplacement {
  line: number;
  section: string | null;
  key: string;
}

/** Every start-limit key that is NOT inside [Unit], with its 1-based line and section. */
function findMisplacedStartLimitKeys(text: string): Misplacement[] {
  const out: Misplacement[] = [];
  let section: string | null = null;
  text.split('\n').forEach((raw, idx) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      return;
    }
    const key = START_LIMIT_KEY.exec(line);
    if (key && section !== 'Unit') out.push({ line: idx + 1, section, key: key[1] });
  });
  return out;
}

function unitFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...unitFiles(p));
    else if (UNIT_FILE.test(name)) found.push(p);
  }
  return found;
}

describe('systemd start-limit keys live in [Unit] (WI-10006428)', () => {
  it('flags a start-limit key under [Service] and accepts the same key under [Unit] (control)', () => {
    // Control: without this, a detector that never matches would let the real scan below
    // pass vacuously.
    const misplaced = '[Unit]\nDescription=x\n\n[Service]\nRestart=always\nStartLimitIntervalSec=0\n';
    expect(findMisplacedStartLimitKeys(misplaced)).toEqual([
      { line: 6, section: 'Service', key: 'StartLimitIntervalSec' },
    ]);
    const correct = '[Unit]\nStartLimitIntervalSec=0\nStartLimitBurst=3\n\n[Service]\nRestart=always\n';
    expect(findMisplacedStartLimitKeys(correct)).toEqual([]);
    // A key before any section header is not in [Unit] either.
    expect(findMisplacedStartLimitKeys('StartLimitBurst=5\n[Unit]\n')).toHaveLength(1);
    // Commented-out keys are not settings.
    expect(findMisplacedStartLimitKeys('[Service]\n# StartLimitBurst=5\n')).toEqual([]);
  });

  it('no tracked unit or drop-in puts a start-limit key outside [Unit]', () => {
    const files = unitFiles(SYSTEMD_DIR);
    // Positive control on the population: the scan must actually see unit files, and at
    // least one of them must carry a start-limit key, or a broken walk reads as clean.
    expect(files.length).toBeGreaterThan(10);
    const withKey = files.filter((f) =>
      readFileSync(f, 'utf8').split('\n').some((l) => START_LIMIT_KEY.test(l.trim())),
    );
    expect(withKey.length).toBeGreaterThan(0);

    const offenders = files.flatMap((f) =>
      findMisplacedStartLimitKeys(readFileSync(f, 'utf8')).map(
        (m) => `${relative(SYSTEMD_DIR, f)}:${m.line} ${m.key} in [${m.section ?? 'no section'}]`,
      ),
    );
    expect(offenders, 'start-limit keys must be in [Unit]; systemd ignores them elsewhere').toEqual([]);
  });
});
