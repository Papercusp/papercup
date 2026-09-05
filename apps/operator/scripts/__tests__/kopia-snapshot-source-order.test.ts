/**
 * kopia-snapshot-source-order.test.ts — WI-2146225 recurrence guard.
 *
 * WHAT WENT WRONG, TWICE, IN THE SAME PLACE.
 *
 * `kopia-snapshot-all.sh` discovers what to back up by asking kopia which
 * sources ALREADY HAVE a snapshot. That is self-referential: a directory that
 * has never been snapshotted cannot enter the list, by construction, so there
 * was no registration path at all. When WI-2145150 relocated the Postgres dumps
 * to /mnt/backup/db-dumps, the new directory had no snapshot, discovery never
 * returned it, and it therefore never got one. The dumps kept being produced
 * perfectly and stopped leaving the box entirely — for 13 hours, with every
 * existing check green.
 *
 * The first fix added REQUIRED_SOURCES, unioned in unconditionally. It was
 * correct and it was NOT SUFFICIENT. This sweep runs one `kopia snapshot
 * create` at --parallel=1, so sources are visited in order, and the backup
 * guard aborts the run mid-flight under memory/io pressure — over the 48h to
 * 2026-09-05, 51 hot cycles started, 46 were killed mid-run, 6 finished. A
 * killed cycle yields a PREFIX of the source list. `sort -u` put
 * /mnt/backup/db-dumps in the /mnt/* tail behind every /home/* source, so the
 * 13:00:04 cycle was killed at 96 seconds having never reached it. The blind
 * spot had moved from "cannot enter the list" to "is always last in a list that
 * rarely finishes" — same zero coverage, same silence, one layer down.
 *
 * WHY A TEST. Both failures are invisible: the sweep exits 0, logs a plausible
 * source count, and every aggregate check stays green because 15 healthy
 * sources mask one absent one. Nothing anywhere reports "this directory has no
 * snapshot". The invariant below is the only thing that fails loudly.
 *
 * THE INVARIANT. A required source with NO snapshot must be passed to
 * `kopia snapshot create` FIRST — ahead of every already-covered source.
 * Unbounded exposure (nothing to restore from, at any age) outranks a
 * covered source going 30 minutes staler.
 *
 * These assertions EXECUTE the real script against a fake kopia and read the
 * argv it was called with, rather than grepping the source text — a static
 * check would pass against a script that computes a perfect list and then
 * hands it over in the wrong order, which is precisely the bug.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY
// outside the tree, so falsifiability can be proven without mutating the shared
// checkout (where the git-sync sweep would commit the mutant mid-probe).
const SCRIPT =
  process.env.KOPIA_SNAPSHOT_ORDER_SCRIPT ||
  resolve(__dirname, '..', 'systemd', 'kopia-snapshot-all.sh');

let dir: string;

/** Sources the fake kopia reports as already having a snapshot. */
function writeFakes(alreadySnapshotted: string[]): void {
  // Fake sudo: drop the leading -n (and an optional --) and exec the rest.
  writeFileSync(
    join(dir, 'sudo'),
    '#!/usr/bin/env bash\nwhile [ "$1" = "-n" ] || [ "$1" = "--" ]; do shift; done\nexec "$@"\n',
  );
  // Fake kopia: answer `snapshot list --all`, and record the argv of
  // `snapshot create` verbatim so the ORDER is observable.
  const listing = alreadySnapshotted
    .map((s) => `backup@host:${s} 2026-09-05 13:00:00 EDT k0 1 GB drwxr-xr-x`)
    .join('\n');
  writeFileSync(
    join(dir, 'kopia'),
    `#!/usr/bin/env bash
if [ "$1" = "snapshot" ] && [ "$2" = "list" ]; then
  cat <<'LISTING'
${listing}
LISTING
  exit 0
fi
if [ "$1" = "snapshot" ] && [ "$2" = "create" ]; then
  shift 2
  printf '%s\\n' "$@" > ${JSON.stringify(join(dir, 'create-argv'))}
  exit 0
fi
exit 0
`,
  );
  for (const f of ['sudo', 'kopia']) chmodSync(join(dir, f), 0o755);
}

/** Run the sweep and return the source arguments, in the order kopia saw them. */
function runSweep(requiredDir: string): string[] {
  execFileSync('/usr/bin/env', ['bash', SCRIPT], {
    env: {
      ...process.env,
      HOME: join(dir, 'home'),
      KOPIA_BACKUP_GUARD_ACTIVE: '1', // do not re-enter the pressure guard
      KOPIA_SNAPSHOT_LOG_DIR: join(dir, 'log'),
      KOPIA_SNAPSHOT_SUDO: join(dir, 'sudo'),
      KOPIA_SNAPSHOT_BIN: join(dir, 'kopia'),
      PAPERCUSP_HOST_PG_DUMP_DIR: requiredDir,
    },
    timeout: 60_000,
  });
  return readFileSync(join(dir, 'create-argv'), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0 && l !== '--parallel=1');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kopia-order-'));
  mkdirSync(join(dir, 'home', '.config', 'kopia', 'hooks'), { recursive: true });
  // The sweep runs a pre-snapshot DB hook unconditionally; stub it out.
  const hook = join(dir, 'home', '.config', 'kopia', 'hooks', 'pre-snapshot.sh');
  writeFileSync(hook, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(hook, 0o755);
  mkdirSync(join(dir, 'dumps'), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('kopia-snapshot-all.sh source ordering', () => {
  it('puts a NEVER-snapshotted required source FIRST, ahead of covered sources', () => {
    // The required dir sits under the tmpdir, which sorts AFTER the covered
    // sources below — mirroring production, where /mnt/... sorted after every
    // /home/... source. Under the previous `sort -u` union that put the
    // required dir last, which is how a pressure-killed cycle skipped it
    // every single time while reporting a healthy source count.
    writeFakes(['/srv/a-source', '/srv/z-source', '/opt/another']);
    const argv = runSweep(join(dir, 'dumps'));

    expect(argv[0]).toBe(join(dir, 'dumps'));
    expect(argv.length).toBe(4);
  });

  it('still passes every already-covered source, so priority is not exclusion', () => {
    writeFakes(['/srv/a-source', '/srv/z-source', '/opt/another']);
    const argv = runSweep(join(dir, 'dumps'));

    for (const s of ['/srv/a-source', '/srv/z-source', '/opt/another']) {
      expect(argv).toContain(s);
    }
  });

  it('does NOT duplicate a required source that is already covered', () => {
    const dumps = join(dir, 'dumps');
    writeFakes(['/srv/a-source', dumps]);
    const argv = runSweep(dumps);

    expect(argv.filter((s) => s === dumps).length).toBe(1);
  });

  it('snapshots the required source even when discovery returns NOTHING', () => {
    // The old union produced an empty list here and warned instead of acting.
    // A repo with no snapshots at all is exactly when bootstrapping matters.
    writeFakes([]);
    const argv = runSweep(join(dir, 'dumps'));

    expect(argv).toEqual([join(dir, 'dumps')]);
  });

  it('never snapshots a required source that does not exist on disk', () => {
    // A box without this directory must not be spammed with errors for it.
    writeFakes(['/srv/a-source']);
    const argv = runSweep(join(dir, 'no-such-directory'));

    expect(argv).toEqual(['/srv/a-source']);
  });
});
