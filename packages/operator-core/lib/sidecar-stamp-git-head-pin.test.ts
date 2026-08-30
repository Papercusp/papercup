/**
 * sidecar-stamp-git-head-pin.test.ts — regression guard for EI-21826568874232796.
 *
 * THE DEFECT THIS PINS. `papercusp-desktop/bin/build-desktop-sidecar.sh` hard-refuses
 * (exit 2) to start a `vm-release` build without an immutable `PAPERCUSP_BUILD_SHA`:
 * "Pass the immutable source SHA and desktop version explicitly". The freshness stamp
 * it writes near the END of that ~12-minute build then ignored the pin and recorded a
 * LIVE `git rev-parse --short HEAD` instead. On this shared checkout a background
 * git-sync sweep commits the whole tree on a short cadence, so HEAD moving inside the
 * build window is routine, and `.sidecar-build-stamp` recorded a sha the bytes were
 * NOT built from — an artifact claiming to describe source it was not built from.
 *
 * THE SCENARIO NO OTHER TEST COVERS is exactly that: HEAD moving BETWEEN build start
 * and stamp write. It is unreachable from a test that cannot run a ~12-minute release
 * build, which is why the resolution was extracted into `bin/lib/stamp-git-head.sh`
 * (the lib/portable-sha256.sh and lib/sidecar-freshness.js pattern: the shape lives
 * once, where it can be tested). This suite drives that helper against a THROWAWAY git
 * repo under os.tmpdir() with HEAD deliberately moved underneath it — the shared
 * checkout is never touched, and no sidecar is built.
 *
 * TWO INDEPENDENT HALVES, because either alone can pass while the defect is live:
 *   1. BEHAVIOUR — the helper records the pin, not the moved HEAD.
 *   2. WIRING    — the producer actually calls the helper for `_stamp_git_head`, and
 *                  no longer carries the inline live `rev-parse`. A correct helper the
 *                  producer bypasses fixes nothing.
 *
 * A CONTROL CASE runs beside the behavioural one: with no pin the helper must return
 * the LIVE short HEAD. Without it, a helper that simply echoed `$PAPERCUSP_BUILD_SHA`
 * unconditionally would pass the behavioural assertion while silently breaking every
 * developer/dogfood build's stamp, and a broken extractor would look like a pass.
 *
 * NOT the "gitHead != HEAD" staleness rule that `bin/lib/sidecar-freshness.js`
 * rejects in writing. That rejected rule is a CONSUMER-side judgement that fires on
 * nearly every build here and trains the bypass. This is a PRODUCER-side identity
 * question — "which source did I build?" — whose answer the producer already holds.
 * Nothing here blocks a build.
 *
 * FALSIFIABILITY. Both subject paths are env-overridable (`PAPERCUSP_STAMP_HELPER_PATH`,
 * `PAPERCUSP_STAMP_PRODUCER_PATH`) so `scripts/mutation-probe.sh` can point this suite
 * at a MUTATED COPY outside the tree — the copy-out tier — instead of mutating the
 * shared checkout, where a git-sync sweep can commit the mutant even when nothing goes
 * wrong. See CLAUDE.md "Proving a guard is falsifiable".
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/sidecar-stamp-git-head-pin.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/build-desktop-sidecar.sh above this test)',
  );
}

const ROOT = repoRoot();

/** Subject paths, overridable so a mutation probe can aim this suite at a COPY. */
const HELPER_PATH =
  process.env.PAPERCUSP_STAMP_HELPER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'stamp-git-head.sh');
const PRODUCER_PATH =
  process.env.PAPERCUSP_STAMP_PRODUCER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');

/** Comments never count — a rule that a comment can satisfy is not a rule. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'stamp-guard',
  GIT_AUTHOR_EMAIL: 'stamp-guard@example.invalid',
  GIT_COMMITTER_NAME: 'stamp-guard',
  GIT_COMMITTER_EMAIL: 'stamp-guard@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
    // WI-41180: a sync spawn blocks the worker's event loop, so vitest cannot time it
    // out, and the pure lane shares one fork across ~2,740 files — an unbounded hang
    // here wedges all of them until the batch watchdog fires 45 minutes later.
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}

/**
 * Source the helper and call it, exactly as the producer does: under `set -euo
 * pipefail`, in a command substitution. If the helper can kill a build that has
 * already done twenty minutes of work, this is where that shows up.
 */
function callHelper(repoArg: string, env: Record<string, string | undefined>): string {
  const script = `set -euo pipefail\n. "$1"\npapercusp_stamp_git_head "$2"\n`;
  const clean = { ...process.env, ...GIT_ENV } as Record<string, string | undefined>;
  delete clean.PAPERCUSP_BUILD_SHA;
  return execFileSync('bash', ['-c', script, 'stamp-guard', HELPER_PATH, repoArg], {
    encoding: 'utf8',
    env: { ...clean, ...env } as NodeJS.ProcessEnv,
    // WI-41180 — see the note in git() above. This one matters most: it sources a shell
    // helper, so a hang here is a hang in someone else's script, not in our own code.
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}

describe('EI-21826568874232796 — the sidecar stamp records the pinned source, not a moved HEAD', () => {
  let work: string;
  let repo: string;
  /** The commit the build was PINNED to (captured at build start). */
  let pinned: string;
  /** The commit a git-sync sweep moved HEAD to DURING the build. */
  let swept: string;
  let sweptShort: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'stamp-git-head-guard-'));
    repo = join(work, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'staging', repo], {
      env: { ...process.env, ...GIT_ENV },
      // WI-41180 — see the note in git() above.
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });

    writeFileSync(join(repo, 'serve.mjs'), 'the bytes this build was pinned to\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'the source this build is pinned to']);
    pinned = git(repo, ['rev-parse', 'HEAD']);

    // The git-sync sweep: a peer's unrelated change lands mid-build and HEAD moves.
    writeFileSync(join(repo, 'peer-change.txt'), 'a peer edit swept in mid-build\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'git-sync: sweep the shared tree']);
    swept = git(repo, ['rev-parse', 'HEAD']);
    sweptShort = git(repo, ['rev-parse', '--short', 'HEAD']);

    expect(swept, 'the fixture must actually move HEAD, or it proves nothing').not.toBe(pinned);
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('the helper exists — it is the extracted seam this guard tests', () => {
    expect(
      existsSync(HELPER_PATH),
      `expected the stamp gitHead helper at ${HELPER_PATH}`,
    ).toBe(true);
  });

  // ── 1. BEHAVIOUR: the scenario no other test covers ──────────────────────────
  it('records the PIN when HEAD moved between build start and stamp write', () => {
    const recorded = callHelper(repo, { PAPERCUSP_BUILD_SHA: pinned });

    expect(recorded).toBe(pinned);
    // Stated as its own assertion because THIS is the regression: the stamp used to
    // record wherever the sweep had left HEAD by the time assembly finished.
    expect(recorded).not.toBe(swept);
    expect(recorded).not.toBe(sweptShort);
  });

  it('records the pin verbatim even when the caller pins a SHORT sha', () => {
    const shortPin = pinned.slice(0, 10);
    expect(callHelper(repo, { PAPERCUSP_BUILD_SHA: shortPin })).toBe(shortPin);
  });

  // ── 2. CONTROL: the un-pinned path must keep its live reading ────────────────
  // Without this, a helper that unconditionally echoed $PAPERCUSP_BUILD_SHA would
  // satisfy every assertion above while breaking every dogfood build's stamp.
  it('CONTROL — with no pin it still reports the live short HEAD (dogfood unchanged)', () => {
    expect(callHelper(repo, { PAPERCUSP_BUILD_SHA: undefined })).toBe(sweptShort);
  });

  it('treats a blank/whitespace-only pin as absent, exactly as the vm-release gate does', () => {
    expect(callHelper(repo, { PAPERCUSP_BUILD_SHA: '   ' })).toBe(sweptShort);
    expect(callHelper(repo, { PAPERCUSP_BUILD_SHA: '' })).toBe(sweptShort);
  });

  it('yields `unknown` rather than killing a verified build outside a git repo', () => {
    // A metadata stamp must never kill a fully-built, verified sidecar (EI-9905).
    expect(callHelper(join(work, 'not-a-repo'), { PAPERCUSP_BUILD_SHA: undefined })).toBe(
      'unknown',
    );
  });

  // ── 3. WIRING: a correct helper the producer bypasses fixes nothing ──────────
  describe('build-desktop-sidecar.sh actually uses the helper for the stamp', () => {
    let producer: string;

    beforeAll(() => {
      producer = codeOnly(readFileSync(PRODUCER_PATH, 'utf8'));
    });

    it('sources lib/stamp-git-head.sh', () => {
      expect(producer).toMatch(/(?:^|\s)(?:source|\.)\s+"\$HERE\/lib\/stamp-git-head\.sh"/m);
    });

    it('assigns _stamp_git_head from papercusp_stamp_git_head', () => {
      expect(producer).toMatch(/_stamp_git_head="\$\(\s*papercusp_stamp_git_head\s+"\$REPO_ROOT"\s*\)"/);
    });

    it('carries NO inline live rev-parse for _stamp_git_head (the reverted shape)', () => {
      const inlineRevParse = producer
        .split('\n')
        .filter((line) => /_stamp_git_head=/.test(line) && /rev-parse/.test(line));
      expect(inlineRevParse).toEqual([]);
    });

    it('still writes that resolved value as the stamp\'s gitHead', () => {
      expect(producer).toMatch(/"gitHead":\s*"%s"[^\n]*\n?[^\n]*"\$_stamp_git_head"/);
    });
  });
});
