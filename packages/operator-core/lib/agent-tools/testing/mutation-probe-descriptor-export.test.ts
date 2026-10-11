/**
 * Mutation descriptor export (plan mutation-probe-evidence-value-2026-10-11, P-001
 * hop 2 / BAR R-1; field set D-003, reader gate D-006).
 *
 * `scripts/mutation-probe.sh` builds ONE descriptor per invocation — subject path,
 * mode, the literal --mutate expression or the full historical commit, before/after
 * subject hashes, a bounded diff and the --test template hash — and exports it to
 * every guard leg as PAPERCUSP_MUTATION_DESCRIPTOR, where the test-run reporter
 * persists it at execution_details.mutation. In `auto` the export waits until the
 * deployed reader (its /api/health sha → libs/test-config gitlink) carries the
 * descriptor parser, because that reader parses execution_details strictly (D-001).
 *
 * Runs the real script against throwaway Git repositories; the guard is a recorder
 * that captures the environment each leg actually received. No mocks.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseMutationInvocationDescriptor } from '@papercusp/test-config/mutation-descriptor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = process.env.MUTATION_PROBE_SCRIPT ?? resolve(__dirname, '../../../../../scripts/mutation-probe.sh');
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

let dir: string;
let admissionBase: string;
let previousAdmissionBase: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mutation-probe-descriptor-'));
  previousAdmissionBase = process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
  admissionBase = mkdtempSync(join(tmpdir(), 'mutation-probe-descriptor-admission-'));
  process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT = admissionBase;
});

afterEach(() => {
  rmSync(admissionBase, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  if (previousAdmissionBase === undefined) delete process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
  else process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT = previousAdmissionBase;
});

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  return (r.stdout ?? '').trim();
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(repo, ['config', 'user.name', 'mutation-probe-test']);
}

const ORIGINAL = 'stable-control\nguarded\n';
const HISTORICAL = 'stable-control\nlegacy-path\n';

/** subject.txt committed twice: a before-fix source (no `guarded`) then the current one. */
function makeSubjectRepo(): { file: string; oldSha: string } {
  const repo = join(dir, 'repo');
  initRepo(repo);
  const file = join(repo, 'subject.txt');
  writeFileSync(file, HISTORICAL);
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'historical source']);
  const oldSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(file, ORIGINAL);
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'fix source']);
  return { file, oldSha };
}

/** The guard: record (phase, descriptor) for every leg, fail unless the subject says `guarded`. */
function makeRecorder(): { recorder: string; log: string } {
  const recorder = join(dir, 'recorder.cjs');
  const log = join(dir, 'legs.jsonl');
  writeFileSync(
    recorder,
    `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  phase: process.env.PAPERCUSP_MUTATION_PHASE ?? null,
  descriptor: process.env.PAPERCUSP_MUTATION_DESCRIPTOR ?? null,
}) + '\\n');
process.exit(/^guarded$/m.test(fs.readFileSync(process.argv[2], 'utf8')) ? 0 : 1);
`,
  );
  return { recorder, log };
}

function legs(log: string): Array<{ phase: string | null; descriptor: string | null }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function probe(args: string[], env: Record<string, string | undefined>): { code: number; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const MUTATE = 's/^guarded$/MUTATED/';

describe('mutation-probe.sh descriptor export (R-1)', () => {
  it('copy-out: every leg receives the SAME strict descriptor naming the subject, expression, hashes and diff', () => {
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const test = `node ${recorder} {}`;
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', test], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always',
    });

    expect(code, out).toBe(0);
    const seen = legs(log);
    expect(seen.map((l) => l.phase)).toEqual(expect.arrayContaining(['baseline', 'mutant']));
    const raw = seen[0]!.descriptor;
    expect(raw).not.toBeNull();
    expect(new Set(seen.map((l) => l.descriptor))).toEqual(new Set([raw]));

    const descriptor = parseMutationInvocationDescriptor(JSON.parse(raw!));
    expect(descriptor).toBeDefined();
    expect(descriptor).toMatchObject({
      mode: 'copy-out',
      subjectPath: 'subject.txt',
      mutateExpression: MUTATE,
      againstCommit: null,
      subjectBeforeSha256: sha256(ORIGINAL),
      subjectAfterSha256: sha256(ORIGINAL.replace(/^guarded$/m, 'MUTATED')),
      mutantDiffTruncated: false,
      testCommandSha256: sha256(test),
    });
    expect(descriptor!.mutantDiff).toMatch(/^--- a\/subject\.txt$/m);
    expect(descriptor!.mutantDiff).toMatch(/^-guarded$/m);
    expect(descriptor!.mutantDiff).toMatch(/^\+MUTATED$/m);
    expect(out).toContain(`probeInvocationId=${descriptor!.probeInvocationId}`);
  });

  it('historical: the descriptor names the full before-fix commit and no expression', () => {
    const { file, oldSha } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const test = `node ${recorder} {}`;
    const { code, out } = probe(
      [
        '--file', file,
        '--against-commit', oldSha,
        '--must-be-absent', 'guarded',
        '--positive-control', 'stable-control',
        '--calibration', 'grep -q "^stable-control$" {}',
        '--test', test,
      ],
      { PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'always' },
    );

    expect(code, out).toBe(0);
    const descriptors = new Set(legs(log).map((l) => l.descriptor));
    expect(descriptors.size).toBe(1);
    const descriptor = parseMutationInvocationDescriptor(JSON.parse([...descriptors][0]!));
    expect(descriptor).toMatchObject({
      mode: 'historical',
      subjectPath: 'subject.txt',
      mutateExpression: null,
      againstCommit: oldSha,
      subjectBeforeSha256: sha256(ORIGINAL),
      subjectAfterSha256: sha256(HISTORICAL),
    });
    expect(oldSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('auto: withholds the export when the deployed reader is unreadable, and never forwards a stale caller value', () => {
    const { file } = makeSubjectRepo();
    const { recorder, log } = makeRecorder();
    const { code, out } = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
      PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
      PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: `file://${join(dir, 'no-such-health.json')}`,
      PAPERCUSP_MUTATION_DESCRIPTOR: '{"stale":"caller value"}',
    });

    expect(code, out).toBe(0);
    expect(out).toMatch(/mutation descriptor withheld: the deployed reader's build sha is unreadable/);
    const seen = legs(log);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((l) => l.descriptor === null)).toBe(true);
  });

  it('auto: turns on only when the deployed build\'s libs/test-config gitlink carries the descriptor parser', () => {
    // A reader superproject whose libs/test-config is a gitlink: commit OLD predates
    // the parser, commit NEW contains src/mutation-descriptor.ts.
    const reader = join(dir, 'reader');
    initRepo(reader);
    const sub = join(reader, 'libs', 'test-config');
    initRepo(sub);
    writeFileSync(join(sub, 'README'), 'test-config\n');
    git(sub, ['add', 'README']);
    git(sub, ['commit', '-qm', 'before parser']);
    git(reader, ['add', 'libs/test-config']);
    git(reader, ['commit', '-qm', 'reader without parser']);
    const oldReader = git(reader, ['rev-parse', 'HEAD']);
    mkdirSync(join(sub, 'src'));
    writeFileSync(join(sub, 'src', 'mutation-descriptor.ts'), 'export {};\n');
    git(sub, ['add', 'src/mutation-descriptor.ts']);
    git(sub, ['commit', '-qm', 'descriptor parser']);
    git(reader, ['add', 'libs/test-config']);
    git(reader, ['commit', '-qm', 'reader with parser']);
    const newReader = git(reader, ['rev-parse', 'HEAD']);

    const health = join(dir, 'health.json');
    const run = (readerSha: string) => {
      writeFileSync(health, JSON.stringify({ ok: true, service: 'papercusp-operator', sha: readerSha.slice(0, 10) }));
      const { file } = makeSubjectRepoAt(join(dir, `repo-${readerSha.slice(0, 6)}`));
      const { recorder, log } = makeRecorderAt(join(dir, `legs-${readerSha.slice(0, 6)}`));
      const result = probe(['--file', file, '--mutate', MUTATE, '--test', `node ${recorder} {}`], {
        PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'auto',
        PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: `file://${health}`,
        PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO: reader,
      });
      return { ...result, legs: legs(log) };
    };

    const before = run(oldReader);
    expect(before.code, before.out).toBe(0);
    expect(before.out).toMatch(/withheld: deployed reader [0-9a-f]+ .* predates the descriptor parser/);
    expect(before.legs.every((l) => l.descriptor === null)).toBe(true);

    const after = run(newReader);
    expect(after.code, after.out).toBe(0);
    expect(after.out).toMatch(/mutation descriptor on: deployed reader [0-9a-f]+ parses execution_details\.mutation/);
    expect(after.legs.length).toBeGreaterThan(0);
    expect(after.legs.every((l) => l.descriptor !== null && parseMutationInvocationDescriptor(JSON.parse(l.descriptor)))).toBe(true);
  });
});

function makeSubjectRepoAt(repo: string): { file: string } {
  initRepo(repo);
  const file = join(repo, 'subject.txt');
  writeFileSync(file, ORIGINAL);
  git(repo, ['add', 'subject.txt']);
  git(repo, ['commit', '-qm', 'source']);
  return { file };
}

function makeRecorderAt(base: string): { recorder: string; log: string } {
  mkdirSync(base, { recursive: true });
  const recorder = join(base, 'recorder.cjs');
  const log = join(base, 'legs.jsonl');
  writeFileSync(
    recorder,
    `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  phase: process.env.PAPERCUSP_MUTATION_PHASE ?? null,
  descriptor: process.env.PAPERCUSP_MUTATION_DESCRIPTOR ?? null,
}) + '\\n');
process.exit(/^guarded$/m.test(fs.readFileSync(process.argv[2], 'utf8')) ? 0 : 1);
`,
  );
  return { recorder, log };
}
