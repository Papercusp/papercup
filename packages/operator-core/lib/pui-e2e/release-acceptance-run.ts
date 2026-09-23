/**
 * The installed-TUI release stage (pui-first-party-public-release P-012 / D-018).
 *
 *   candidate archive -> verified digest -> install.sh into a clean HOME
 *   -> production-operator PTY suites with PUI_BIN=<installed bin/pui>, one leg
 *      per engine, through release-acceptance-reporter
 *   -> checkReleaseAcceptance against the CANDIDATE's own UX contract and matrix
 *   -> <archive>.acceptance.json
 *
 * The verdict is what P-014/P-015 may publish on: an archive is releasable
 * only with a passing acceptance file for that same archive digest. The
 * committed compatibility.json never advertises anything (D-017).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  checkReleaseAcceptance, detectPlatform, judgeEvidence, parseRequiredMatrix, REPO_ROOT,
  type AcceptanceMatrixFile, type Candidate, type EvidenceRow, type Verdict,
} from './release-acceptance';
import type { EvidenceFile } from './release-acceptance-reporter';

export const RELEASE_SUITES = [
  'packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts',
  'packages/operator-core/lib/pui-e2e/context-pane-cockpit-pty.integration.test.ts',
];
/** The code that decides what counts; it must be the candidate's own copy. */
const ACCEPTANCE_SOURCES = [
  ...RELEASE_SUITES,
  'packages/operator-core/lib/pui-e2e/release-acceptance.ts',
  'packages/operator-core/lib/pui-e2e/release-acceptance-reporter.ts',
];
const REPORTER = path.join(REPO_ROOT, 'packages/operator-core/lib/pui-e2e/release-acceptance-reporter.ts');
const VITEST = path.join(REPO_ROOT, 'node_modules/.bin/vitest');
const OPERATOR_CORE = path.join(REPO_ROOT, 'packages/operator-core');

export interface RealLeg {
  /** PUI_REAL_BACKEND: claude | codex | omp. */
  backend: string;
  /** Pinned per D-012; omitted only where D-013 refuses a pin (OMP under account=auto). */
  model?: string;
  env?: Record<string, string>;
}

export interface RunOptions {
  archive: string;
  advertise: Array<{ platform: string; backend: string }>;
  real?: RealLeg[];
  /** Vitest -t pattern; the full release run leaves it unset. */
  testFilter?: string;
  suites?: string[];
  out?: string;
  work?: string;
  /** Test seam: the platform this run's evidence is recorded against. */
  platform?: string;
}

export interface RunResult {
  verdict: Verdict;
  out: string;
  legs: Array<{ engine: string; status: number | null; evidence: string; rows: number }>;
  suiteProvenance: Array<{ file: string; candidateBlob: string | null; runBlob: string | null }>;
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args: string[]) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();

function committed(sha: string, file: string): string | null {
  const run = spawnSync('git', ['-C', REPO_ROOT, 'show', `${sha}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : null;
}

function blob(ref: string | null, file: string): string | null {
  const run = ref
    ? spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', '--quiet', `${ref}:${file}`], { encoding: 'utf8' })
    : spawnSync('git', ['-C', REPO_ROOT, 'hash-object', file], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('could not reserve a port');
  return address.port;
}

function unpack(archive: string, work: string): string {
  const dest = path.join(work, 'unit');
  mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', dest]);
  const [top] = readdirSync(dest);
  const unit = path.join(dest, top ?? '');
  if (!top || !existsSync(path.join(unit, 'install.sh'))) throw new Error(`${archive} does not unpack to a release unit`);
  return unit;
}

/** The archive's own digest line for a unit file (CONTENTS.sha256, written by package-release.sh). */
function listedDigest(unit: string, file: string): string | null {
  const line = readFileSync(path.join(unit, 'CONTENTS.sha256'), 'utf8').split('\n')
    .find((entry) => entry.endsWith(`  ${file}`));
  return line ? line.split(/\s+/)[0] : null;
}

export async function runReleaseAcceptance(options: RunOptions): Promise<RunResult> {
  const archive = path.resolve(options.archive);
  const work = options.work ?? mkdtempSync(path.join(tmpdir(), 'pui-release-acceptance-'));
  const archiveSha256 = sha256(archive);
  const sums = path.join(path.dirname(archive), 'SHA256SUMS');
  if (existsSync(sums)) {
    const listed = readFileSync(sums, 'utf8').split('\n').find((line) => line.endsWith(`  ${path.basename(archive)}`));
    if (listed && listed.split(/\s+/)[0] !== archiveSha256) throw new Error(`${archive} does not match its SHA256SUMS entry`);
  }

  const unit = unpack(archive, work);
  const provenance = JSON.parse(readFileSync(path.join(unit, 'PROVENANCE.json'), 'utf8')) as {
    target: string; source: { commit: string };
  };
  const sourceSha = provenance.source.commit;

  const home = path.join(work, 'home');
  mkdirSync(path.join(home, 'tmp'), { recursive: true });
  const install = spawnSync(path.join(unit, 'install.sh'), ['--yes'], {
    cwd: home, encoding: 'utf8', timeout: 300_000,
    env: {
      HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: path.join(home, 'tmp'),
      // install.sh finishes with `pui doctor`; keep it off the developer's live operator.
      PAPERCUSP_HONO_PORT: String(await closedPort()),
    },
  });
  if (install.status !== 0) {
    throw new Error(`install.sh failed (status ${install.status}):\n${install.stdout}\n${install.stderr}`.slice(-8_000));
  }
  const installRoot = realpathSync(path.join(home, '.local', 'share', 'pui'));
  const installed = realpathSync(path.join(installRoot, 'current', 'bin', 'pui'));
  const installedBinarySha256 = sha256(installed);
  if (listedDigest(unit, 'bin/pui') !== installedBinarySha256) {
    throw new Error(`installed ${installed} does not match the archive's CONTENTS.sha256 entry for bin/pui`);
  }

  const platform = options.platform ?? detectPlatform();
  const legs: RunResult['legs'] = [];
  const rows: EvidenceRow[] = [];
  const suites = options.suites ?? RELEASE_SUITES;
  // When the stage itself runs under vitest (its R-12 test), the outer worker's
  // VITEST_* markers must not leak into the suites' own run.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
  for (const leg of [null, ...(options.real ?? [])]) {
    const engine = leg ? leg.backend : 'scripted';
    const evidence = path.join(work, `evidence-${engine}.json`);
    const run = spawnSync(VITEST, [
      'run', '--config', 'vitest.integration.config.ts',
      ...suites.map((file) => path.join(REPO_ROOT, file)),
      ...(options.testFilter ? ['-t', options.testFilter] : []),
      '--reporter=default', `--reporter=${REPORTER}`,
    ], {
      cwd: OPERATOR_CORE, encoding: 'utf8', timeout: 90 * 60_000, maxBuffer: 512 * 1024 * 1024,
      env: {
        ...inherited,
        PUI_BIN: installed,
        // The store install.sh wrote. Suites run PUI under their own HOME, so a
        // journey that reads the release store must be pointed at this one.
        PUI_RELEASE_STORE: installRoot,
        PUI_RELEASE_PLATFORM: platform ?? '',
        PUI_RELEASE_EVIDENCE: evidence,
        ...(leg ? { PUI_REAL_ENGINE: '1', PUI_REAL_BACKEND: leg.backend, ...(leg.model ? { PUI_REAL_MODEL: leg.model } : {}), ...leg.env }
          : { PUI_REAL_ENGINE: '' }),
      },
    });
    writeFileSync(path.join(work, `vitest-${engine}.log`), `${run.stdout ?? ''}\n--- stderr\n${run.stderr ?? ''}`);
    const harvested = existsSync(evidence) ? (JSON.parse(readFileSync(evidence, 'utf8')) as EvidenceFile).rows : [];
    rows.push(...harvested);
    legs.push({ engine, status: run.status, evidence, rows: harvested.length });
  }

  const candidate: Candidate = {
    sourceSha, artifact: provenance.target, archive, archiveSha256, installRoot, installedBinarySha256,
    advertise: options.advertise,
  };
  const contract = committed(sourceSha, 'apps/tui/PUBLIC_RELEASE_UX.md');
  const matrixText = committed(sourceSha, 'apps/tui/release/acceptance-matrix.json');
  const extra: string[] = [];
  if (!contract) extra.push(`candidate ${sourceSha} carries no apps/tui/PUBLIC_RELEASE_UX.md`);
  if (!matrixText) extra.push(`candidate ${sourceSha} carries no apps/tui/release/acceptance-matrix.json`);
  if (!platform) extra.push(`this host (${process.platform}/${process.arch}) is not a platform in the release matrix`);
  const suiteProvenance = ACCEPTANCE_SOURCES.map((file) => ({ file, candidateBlob: blob(sourceSha, file), runBlob: blob(null, file) }));
  for (const entry of suiteProvenance) {
    if (!entry.candidateBlob || entry.candidateBlob !== entry.runBlob) {
      extra.push(`${entry.file} as run is not the candidate's committed copy, so its evidence describes other code`);
    }
  }

  const verdict: Verdict = contract && matrixText
    ? checkReleaseAcceptance(parseRequiredMatrix(contract), JSON.parse(matrixText) as AcceptanceMatrixFile, candidate, rows)
    : { ok: false, candidate, refusals: [], cells: [], capabilities: [], evidence: judgeEvidence(rows, candidate) };
  verdict.refusals.unshift(...extra);
  verdict.ok = verdict.refusals.length === 0;

  const out = options.out ?? `${archive}.acceptance.json`;
  writeFileSync(out, `${JSON.stringify({
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    runner: { head: git('rev-parse', 'HEAD'), platform, legs, suiteProvenance, work },
    ...verdict,
  }, null, 2)}\n`);
  return { verdict, out, legs, suiteProvenance };
}
