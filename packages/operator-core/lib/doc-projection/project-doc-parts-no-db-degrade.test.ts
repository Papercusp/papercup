import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
// @ts-expect-error — native .mjs CLI intentionally has no declaration file.
import { CANDIDATE_ARTIFACTS } from '../../../../scripts/project-doc-parts.mjs';

/**
 * EI-20272515693397454 — the no-DB degrade on `scripts/project-doc-parts.mjs`.
 *
 * ⚠ THIS FILE IS DELIBERATELY DIFFERENT FROM ITS SIBLINGS. project-doc-parts.test.ts and
 * load-claude-md-doc-parts.test.ts both open with "NOTHING HERE READS THE LIVE CLAUDE.md
 * OR A DATABASE" — they import the projector's pure helpers and exercise them over
 * fixtures. That is correct for composition logic, and it is exactly why the branch under
 * test here was invisible to them: it lives in the CLI block, which no import can reach.
 *
 * WHY THE BRANCH EXISTS. `gen:client-docs:check` is this script with no flags, and it is
 * the only assertion anywhere that the generated CLAUDE.md / AGENTS.md still equal a
 * composition of the live `harness_doc_parts` rows. It is now registered in
 * REPO_WIDE_INVARIANT_GUARDS, which means it runs off-box — where there is no papercusp
 * Postgres. Before the degrade, `connect()` sat outside the try and an unreachable
 * database exited non-zero with a stack trace, so registering it would have failed EVERY
 * off-box run and taught the fleet to ignore the leg.
 *
 * WHY THE ASYMMETRY IS THE POINT. The check path may skip; the WRITE paths may not. A
 * write that silently no-ops because its database was unreachable is worse than a loud
 * failure — the caller believes the files were projected when nothing was. That
 * distinction is one `if` away from being erased by a later edit ("just skip on connect
 * failure"), and nothing else in the repo would notice, so it is pinned here.
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
/**
 * Overridable so falsifiability can be proven WITHOUT mutating the shared tree —
 * `scripts/mutation-probe.sh` mutates a COPY outside the tree and points this at it. The
 * copy-out tier is only available because of this one line; without it the only way to
 * prove the guard can fail would be an in-tree mutation, which git-sync's sweep can
 * commit even when nothing goes wrong.
 */
const SCRIPT = process.env.PROBE_PROJECT_DOC_PARTS ?? resolve(ROOT, 'scripts/project-doc-parts.mjs');

/**
 * A port nothing listens on, so `connect()` fails with ECONNREFUSED immediately rather
 * than hanging on a DNS or TCP timeout. HARNESS_ADMIN_DATABASE_URL is FIRST in
 * PG_URL_ENV_VARS, so setting it here beats both the sibling env vars and the repo-root
 * `.env.local` — this can never accidentally reach the real operator database.
 */
const UNREACHABLE_PG = 'postgres://nobody:nobody@127.0.0.1:59999/papercusp_no_such_db';

function runProjector(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  entry: string[] = [SCRIPT],
): { status: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [...entry, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        GREEN_CHECKPOINT: '0',
        PAPERCUSP_TEST_RUN_COMMIT: '',
        HARNESS_ADMIN_DATABASE_URL: UNREACHABLE_PG,
        ...extraEnv,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    return {
      // A signal kill reports status null; surface it as a non-zero so a hang can never
      // read as a clean exit.
      status: typeof e.status === 'number' ? e.status : 1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`,
    };
  }
}

describe('project-doc-parts — the no-DB degrade is CHECK-ONLY', () => {
  function currentCommit(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  }

  it('frozen candidates read committed artifacts and never connect to live Postgres', () => {
    const { status, output } = runProjector([], {
      GREEN_CHECKPOINT: '1',
      PAPERCUSP_TEST_RUN_COMMIT: currentCommit(),
    });
    expect(status).toBe(0);
    expect(output).toContain('frozen candidate');
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('AGENTS.md');
    expect(output).toContain('claude-md-corpus.generated.md');
    expect(output).toContain('no live Postgres read performed');
    expect(output).not.toContain('ECONNREFUSED');
    expect(output).not.toContain('SKIPPED');
  });

  it('frozen candidates fail closed on an unreadable committed artifact without connecting', () => {
    const { status, output } = runProjector([], {
      GREEN_CHECKPOINT: '1',
      PAPERCUSP_TEST_RUN_COMMIT: '0'.repeat(40),
    });
    expect(status).not.toBe(0);
    expect(output).toContain('candidate artifact check failed');
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('Refusing to consult live Postgres');
    expect(output).not.toContain('ECONNREFUSED');
  });

  it('frozen candidates refuse write flags before any database connection', () => {
    const { status, output } = runProjector(['--write'], {
      GREEN_CHECKPOINT: '1',
      PAPERCUSP_TEST_RUN_COMMIT: currentCommit(),
    });
    expect(status).not.toBe(0);
    expect(output).toContain('candidate artifact checks are read-only');
    expect(output).not.toContain('ECONNREFUSED');
  });

  it.each(['--help', '-h'])('prints usage without connecting to Postgres for %s', (flag) => {
    const { status, output } = runProjector([flag, '--write']);
    expect(status).toBe(0);
    expect(output).toContain('Usage:');
    expect(output).toContain('project-doc-parts.mjs');
    expect(output).toContain('--write');
    expect(output).not.toContain('ECONNREFUSED');
    expect(output).not.toContain('dry run — nothing written');
  });

  it('the CHECK path exits 0 when Postgres is unreachable, so the guard is wireable off-box', () => {
    const { status } = runProjector([]);
    expect(status).toBe(0);
  });

  it('...and SAYS it checked nothing — a silent exit 0 would be a false green, not a degrade', () => {
    const { output } = runProjector([]);
    expect(output).toContain('SKIPPED');
    expect(output).toContain('This is NOT a pass: nothing was checked');
    // The resolution description travels with the failure, so the report names WHICH
    // address refused rather than leaving the reader to guess which env var supplied it.
    expect(output).toContain('127.0.0.1:59999');
  });

  it('CONTROL — --write does NOT skip: a mutation whose database vanished must fail LOUDLY', () => {
    const { status, output } = runProjector(['--write']);
    expect(status).not.toBe(0);
    expect(output).not.toContain('SKIPPED');
  });

  it('CONTROL — --write-corpus does not skip either; it writes the tree, so it is held to the same rule', () => {
    const { status, output } = runProjector(['--write-corpus']);
    expect(status).not.toBe(0);
    expect(output).not.toContain('SKIPPED');
  });

  it('CALIBRATION — the probe genuinely reaches the connect seam rather than dying earlier', () => {
    // If the script failed to parse, or exited on argv handling before `connect()`, every
    // assertion above would still pass for the wrong reason. ECONNREFUSED naming the
    // planted port proves the run got as far as opening a socket to the address WE chose.
    const { output } = runProjector([]);
    expect(output).toContain('ECONNREFUSED');
    expect(output).toContain('HARNESS_ADMIN_DATABASE_URL');
  });
});

const OLD_PIPE_BUFFER = 1024 * 1024;
const FAILED_TAIL = '\nFAIL decisive assertion beyond the old buffer Ω\n';
const PASSED_TAIL = '\nTest Files 1 passed\nTests 1 passed\n';
const CHILD_OUTPUT_PREFIX = 'DOC_PART_CHILD_OUTPUT ';
type ChildOutput = {
  pid: number | null;
  status: number | null;
  signal: string | null;
  error: { code: string | null; message: string } | null;
  stdout: { path: string; bytes: number };
  stderr: { path: string; bytes: number };
};

function outputBytes(bytes: number, status: number): Buffer {
  const begin = Buffer.from('BEGIN_NATIVE_CHILD\n');
  const end = Buffer.from(status === 0 ? PASSED_TAIL : FAILED_TAIL);
  return Buffer.concat([begin, Buffer.alloc(bytes - begin.length - end.length, 'x'), end]);
}

function emitter(root: string): string {
  const path = join(root, 'emitter.mjs');
  writeFileSync(path, `
    import { writeSync } from 'node:fs';
    const [bytes, status, stream, signal] = process.argv.slice(2);
    const begin = Buffer.from('BEGIN_NATIVE_CHILD\\n');
    const end = Buffer.from(Number(status) === 0 ? ${JSON.stringify(PASSED_TAIL)} : ${JSON.stringify(FAILED_TAIL)});
    const data = Buffer.concat([begin, Buffer.alloc(Number(bytes) - begin.length - end.length, 'x'), end]);
    const fd = stream === 'stderr' ? 2 : 1;
    // Many writes exercise recovery across chunk boundaries, including UTF-8.
    for (let at = 0; at < data.length;) {
      const written = writeSync(fd, data, at, Math.min(8191, data.length - at));
      if (!written) throw new Error('fixture write made no progress');
      at += written;
    }
    writeSync(fd === 1 ? 2 : 1, 'COMPANION_STREAM Ω\\n');
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = Number(status);
  `);
  return path;
}

function guardFixture(root: string, bytes: number, status: number, stream: string, signal = '', missing = false) {
  const fixture = emitter(root);
  const wrapper = `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { verifyDocClaims } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
    const config = JSON.parse(process.argv[1]);
    const passed = verifyDocClaims({
      env: { ...process.env, PAPERCUSP_SKIP_DOC_CLAIMS_VERIFY: '0' },
      logRoot: config.logs,
      spawn(command, args, options) {
        assert.equal(command, 'npx');
        assert.deepEqual(args, ['vitest', 'run', '--root', 'packages/operator-core',
          '--config', 'vitest.config.ts', 'lib/doc-claims/']);
        return spawnSync(config.missing ? config.fixture + '.missing' : process.execPath,
          [config.fixture, String(config.bytes), String(config.status), config.stream, config.signal], options);
      },
    });
    console.log('GUARD_RESULT ' + JSON.stringify({ passed }));
    process.exitCode = passed ? 0 : 1;
  `;
  const result = runProjector([JSON.stringify({ fixture, bytes, status, stream, signal, missing,
    logs: join(root, 'logs') })], {}, ['--input-type=module', '-e', wrapper]);
  const line = result.output.split('\n').find(value => value.startsWith(CHILD_OUTPUT_PREFIX));
  expect(line, result.output).toBeDefined();
  return { ...result, record: JSON.parse(line!.slice(CHILD_OUTPUT_PREFIX.length)) as ChildOutput, fixture };
}

describe('project-doc-parts — native lossless child output', () => {
  it.each(['stdout', 'stderr'])('retains %s at N-1, N and N+1 with a nonzero child exit', stream => {
    const root = mkdtempSync(join(tmpdir(), 'projector-output-'));
    try {
      for (const bytes of [OLD_PIPE_BUFFER - 1, OLD_PIPE_BUFFER, OLD_PIPE_BUFFER + 1]) {
        const result = guardFixture(root, bytes, 17, stream);
        expect(result.status, result.output).toBe(1);
        expect(result.record.status).toBe(17);
        expect(result.record.error).toBeNull();
        expect(result.record.signal).toBeNull();
        expect(result.record.pid).toBeGreaterThan(0);
        const primary = stream === 'stdout' ? result.record.stdout : result.record.stderr;
        const companion = stream === 'stdout' ? result.record.stderr : result.record.stdout;
        const recovered = readFileSync(primary.path);
        expect(primary.bytes).toBe(bytes);
        expect(recovered.equals(outputBytes(bytes, 17))).toBe(true);
        expect(readFileSync(companion.path, 'utf8')).toBe('COMPANION_STREAM Ω\n');
        expect(result.output).toContain('doc-claims guards FAILED');
        expect(result.output).toContain('FAIL decisive assertion');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it('recovers a decisive final assertion after the old buffer where native pipes fail', () => {
    const root = mkdtempSync(join(tmpdir(), 'projector-output-control-'));
    try {
      const bytes = OLD_PIPE_BUFFER * 2 + 4096;
      const result = guardFixture(root, bytes, 17, 'stdout');
      const baseline = spawnSync(process.execPath, [result.fixture, String(bytes), '17', 'stdout', ''],
        { encoding: 'utf8', timeout: 30_000 });
      expect(baseline.error && 'code' in baseline.error ? baseline.error.code : null).toBe('ENOBUFS');
      expect(result.status, result.output).toBe(1);
      expect(result.record.status).toBe(17);
      const recovered = readFileSync(result.record.stdout.path);
      expect(recovered.equals(outputBytes(bytes, 17))).toBe(true);
      expect(recovered.indexOf(Buffer.from(FAILED_TAIL))).toBeGreaterThan(OLD_PIPE_BUFFER);
      expect(result.output).toContain('FAIL decisive assertion beyond the old buffer');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  it('keeps passing, signaled and unstarted children distinct with readable log references', () => {
    const root = mkdtempSync(join(tmpdir(), 'projector-output-outcomes-'));
    try {
      const passed = guardFixture(root, OLD_PIPE_BUFFER + 1, 0, 'stdout');
      expect(passed.status, passed.output).toBe(0);
      expect(readFileSync(passed.record.stdout.path).equals(outputBytes(OLD_PIPE_BUFFER + 1, 0))).toBe(true);
      const signaled = guardFixture(root, OLD_PIPE_BUFFER + 1, 17, 'stderr', 'SIGTERM');
      expect(signaled.status).toBe(1);
      expect(signaled.record.status).toBeNull();
      expect(signaled.record.signal).toBe('SIGTERM');
      expect(readFileSync(signaled.record.stderr.path).equals(outputBytes(OLD_PIPE_BUFFER + 1, 17))).toBe(true);
      const missing = guardFixture(root, 1024, 17, 'stdout', '', true);
      expect(missing.status).toBe(1);
      expect(missing.record.error?.code).toBe('ENOENT');
      expect(readFileSync(missing.record.stdout.path).length).toBe(0);
      expect(missing.output).toContain('verification did NOT complete');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it('hashes complete committed artifacts beyond the pipe boundary through the native CLI seam', () => {
    const root = mkdtempSync(join(tmpdir(), 'projector-committed-output-'));
    try {
      const content = outputBytes(OLD_PIPE_BUFFER * 2 + 4096, 17);
      expect(CANDIDATE_ARTIFACTS.length).toBe(3);
      for (const artifact of CANDIDATE_ARTIFACTS as Array<{ path: string }>) {
        const path = join(root, artifact.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, '-c', 'user.name=Native fixture', '-c',
        'user.email=native-fixture@example.invalid', 'commit', '-qm', 'native artifact fixture']);
      const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const wrapper = `
        import { readCommittedCandidateArtifacts } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
        const config = JSON.parse(process.argv[1]);
        const result = readCommittedCandidateArtifacts(config);
        console.log('ARTIFACT_RESULT ' + JSON.stringify(result));
        process.exitCode = result.ok ? 0 : 1;
      `;
      const result = runProjector([JSON.stringify({ root, commit, logRoot: join(root, 'logs') })], {},
        ['--input-type=module', '-e', wrapper]);
      expect(result.status, result.output).toBe(0);
      const line = result.output.split('\n').find(value => value.startsWith('ARTIFACT_RESULT '));
      expect(line).toBeDefined();
      const observed = JSON.parse(line!.slice('ARTIFACT_RESULT '.length));
      expect(observed.artifacts).toHaveLength(3);
      for (const artifact of observed.artifacts) {
        expect(artifact.bytes).toBe(content.length);
        expect(artifact.sha256).toBe(createHash('sha256').update(content).digest('hex'));
      }
      const records = result.output.split('\n').filter(value => value.startsWith(CHILD_OUTPUT_PREFIX))
        .map(value => JSON.parse(value.slice(CHILD_OUTPUT_PREFIX.length)) as ChildOutput);
      expect(records).toHaveLength(3);
      for (const record of records) expect(readFileSync(record.stdout.path).equals(content)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
