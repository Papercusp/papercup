import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

/**
 * Guards `scripts/restore-pg-dump.sh` — the ONLY documented path for restoring
 * a Postgres dump in this repo, and therefore the disaster-recovery story.
 *
 * WHY THIS EXISTS (WI-37835, 2026-08-11). Two defects were found by actually
 * running a restore drill against the real hourly host backup, and BOTH were
 * invisible to every cheaper check:
 *
 *   1. The script could not read the artifact at all. It guarded on
 *      `[[ ! -f "$DUMP_PATH" ]]` and piped through `psql -f`, so the host
 *      backup — a `pg_dump -Fd` DIRECTORY — exited 1 "dump file not found"
 *      before doing anything. The primary DR artifact was unrestorable by the
 *      documented DR tool.
 *   2. Once it could read it, the restore silently did NOTHING: the archive
 *      directory was mode 0700 for a different user than the one running
 *      pg_restore. Because pg_restore continues past errors, that surfaced as
 *      a single error line amid ordinary ordering noise, and the run otherwise
 *      resembled a success.
 *
 * The tests below therefore assert BEHAVIOUR AT THE SEAMS THAT LIED — which
 * binary got invoked with which format, and whether a restore that produced
 * nothing is allowed to report success. They deliberately do NOT assert the
 * script's internal wording or structure, so a rewrite that keeps the contract
 * keeps passing.
 *
 * No Postgres is required: `psql` and `pg_restore` are replaced by stubs on
 * PATH that record their argv. That is the point — we are testing the ROUTING
 * DECISION, and a test that needed a live 24GB restore to check it would never
 * be run.
 */

const SCRIPT = resolve(__dirname, '../scripts/restore-pg-dump.sh');

let dir: string;
let binDir: string;
let argvLog: string;

/** Read the recorded invocations of a stubbed binary. */
function callsTo(bin: string): string[] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith(`${bin} `));
}

interface RunOpts {
  /** Make the `pg_restore --list` preflight fail, i.e. an unreadable archive. */
  unreadableArchive?: boolean;
  /** What the harness_docs content-integrity query reports, as "total|withContent". */
  docStats?: string;
}

function runScript(dumpPath: string, opts: RunOpts = {}) {
  return spawnSync('bash', [SCRIPT, dumpPath, 'restore_scratch_test', 'postgresql://u@localhost:5999/postgres'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      ARGV_LOG: argvLog,
      STUB_PGRESTORE_LIST_FAILS: opts.unreadableArchive ? '1' : '',
      STUB_DOC_STATS: opts.docStats ?? '983|983',
    },
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'restore-pg-dump-routing-'));
  binDir = join(dir, 'bin');
  argvLog = join(dir, 'argv.log');
  await mkdir(binDir, { recursive: true });

  // --- stub: pg_restore ---------------------------------------------------
  // Records argv. `--list` is the readability preflight and can be told to
  // fail, which is how we simulate the 0700-archive defect without needing a
  // second OS user.
  await writeFile(
    join(binDir, 'pg_restore'),
    `#!/usr/bin/env bash
echo "pg_restore $*" >> "$ARGV_LOG"
for a in "$@"; do
  if [[ "$a" == "--list" ]]; then
    [[ -n "$STUB_PGRESTORE_LIST_FAILS" ]] && exit 1
    exit 0
  fi
done
exit 0
`,
    { mode: 0o755 },
  );

  // --- stub: psql ---------------------------------------------------------
  // Answers the three query shapes the script actually issues. The database
  // -existence probe must say "1" so the script takes its already-exists path
  // (CREATE DATABASE is not what these tests are about), and the doc-corpus
  // query returns a caller-controlled "total|withContent" so the
  // content-integrity verdict can be exercised in both directions.
  await writeFile(
    join(binDir, 'psql'),
    `#!/usr/bin/env bash
echo "psql $*" >> "$ARGV_LOG"
for a in "$@"; do
  case "$a" in
    *count\\(content\\)*) echo "$STUB_DOC_STATS"; exit 0 ;;
    *pg_database*)        echo "1";               exit 0 ;;
    *count\\(*\\)*)        echo "42";              exit 0 ;;
  esac
done
# Not a query — this is the plain-SQL import (\`-f -\`), so DRAIN STDIN.
# A stub that exits without reading leaves \`gzip -dc | sed | psql\` to die of
# SIGPIPE, and under \`set -o pipefail\` the script would then report a genuine
# import failure that only the stub caused.
cat > /dev/null 2>&1 || true
exit 0
`,
    { mode: 0o755 },
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A pg_dump -Fd archive is a directory holding toc.dat. */
async function makeDirectoryArchive(name: string): Promise<string> {
  const p = join(dir, name);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, 'toc.dat'), 'not-really-a-toc');
  await writeFile(join(p, '3001.dat.gz'), gzipSync(Buffer.from('rows')));
  return p;
}

describe('restore-pg-dump.sh — archive format routing', () => {
  it('routes a pg_dump -Fd DIRECTORY to pg_restore, not psql', async () => {
    await rm(argvLog, { force: true });
    const archive = await makeDirectoryArchive('dirfmt');

    const res = runScript(archive);

    expect(res.status).toBe(0);
    const restoreCalls = callsTo('pg_restore');
    // The import call is the one carrying --format (the preflight is --list).
    const importCall = restoreCalls.find((c) => c.includes('--format'));
    expect(importCall, `pg_restore was never invoked to import:\n${res.stdout}`).toBeDefined();
    expect(importCall).toContain('--format=directory');
    expect(importCall).toContain(archive);

    // The plain-SQL leg must NOT have been used: that is the original defect,
    // where a directory archive was fed to `psql -f -` and died.
    expect(callsTo('psql').some((c) => c.includes('-f -'))).toBe(false);
  });

  it('routes a -Fc CUSTOM-format file to pg_restore by MAGIC BYTES, not by filename', async () => {
    await rm(argvLog, { force: true });
    // No extension at all, and the content is what identifies it.
    const custom = join(dir, 'some-archive-with-no-extension');
    await writeFile(custom, Buffer.concat([Buffer.from('PGDMP'), Buffer.from([1, 2, 3])]));

    const res = runScript(custom);

    expect(res.status).toBe(0);
    const importCall = callsTo('pg_restore').find((c) => c.includes('--format'));
    expect(importCall).toBeDefined();
    expect(importCall).toContain('--format=custom');
  });

  it('still routes plain .sql.gz to psql, and never calls pg_restore', async () => {
    await rm(argvLog, { force: true });
    const plain = join(dir, 'dump.sql.gz');
    await writeFile(plain, gzipSync(Buffer.from('-- SQL\nSELECT 1;\n')));

    const res = runScript(plain);

    expect(res.status).toBe(0);
    expect(callsTo('psql').some((c) => c.includes('-f -'))).toBe(true);
    // Regression guard for the plain leg: adding archive support must not have
    // rerouted the format that already worked.
    expect(callsTo('pg_restore')).toHaveLength(0);
  });
});

describe('restore-pg-dump.sh — refusals that prevent a silent no-op restore', () => {
  it('REFUSES an archive it cannot read, before importing anything', async () => {
    await rm(argvLog, { force: true });
    const archive = await makeDirectoryArchive('unreadable');

    const res = runScript(archive, { unreadableArchive: true });

    expect(res.status).not.toBe(0);
    // The operator must be told it is a PERMISSIONS problem — the raw failure
    // ("could not open input file .../toc.dat") points at a file when the
    // actual cause is the directory's traverse bit.
    expect(res.stderr.toLowerCase()).toContain('not readable');
    // And crucially: it must not have gone on to "restore" nothing.
    expect(callsTo('pg_restore').some((c) => c.includes('--format'))).toBe(false);
  });

  it('REFUSES a directory that is not a pg_dump archive (no toc.dat)', async () => {
    await rm(argvLog, { force: true });
    const notAnArchive = join(dir, 'just-a-folder');
    await mkdir(notAnArchive, { recursive: true });
    await writeFile(join(notAnArchive, 'papercusp'), 'a file, but no toc.dat here');

    const res = runScript(notAnArchive);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('toc.dat');
    expect(callsTo('pg_restore').some((c) => c.includes('--format'))).toBe(false);
  });

  it('FAILS a restore whose doc rows came back with NO content — a row count is not evidence the prose survived', async () => {
    await rm(argvLog, { force: true });
    const archive = await makeDirectoryArchive('emptycontent');

    // The tables exist and are populated, so every table-existence check
    // passes. Only the content assertion can catch this.
    const res = runScript(archive, { docStats: '983|0' });

    expect(res.status).toBe(5);
    expect(res.stderr).toContain('ZERO non-NULL');
  });

  it('PASSES when the doc corpus came back with content intact', async () => {
    await rm(argvLog, { force: true });
    const archive = await makeDirectoryArchive('goodcontent');

    const res = runScript(archive, { docStats: '983|983' });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('983 with non-NULL content');
  });
});
