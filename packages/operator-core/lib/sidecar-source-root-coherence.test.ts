/**
 * sidecar-source-root-coherence.test.ts — regression guard for EI-21832562420831737.
 *
 * THE DEFECT THIS PINS. `papercusp-desktop/bin/build-desktop-sidecar.sh` advertises
 * `REPO_ROOT` as the supported way to relocate a build ("Override locations with REPO_ROOT
 * / PAPERCUSP_ROOT if your layout differs"), and a release-audited cut needs exactly that:
 * build from a pinned, tracked-clean checkout so HEAD cannot move under a ~17-minute build
 * and peers' uncommitted files cannot be baked in. The script then derived the repo root
 * TWICE, independently — `REPO_ROOT="${REPO_ROOT:-$ROOT/..}"` near the top, honouring the
 * override, and `REPO="$(cd "$ROOT/.." && pwd)"` some 4,300 lines below, ignoring it.
 *
 * `$REPO` is not a local convenience: the whole chat-dock half of the build reads through
 * it — `$REPO/apps/tui`, `$REPO/apps/pui-zellij-plugin`, the `git -C "$REPO" rev-parse`
 * that supplies the pui build sha, the dirty probe behind `_PUI_BUILD_DIRTY`, and the
 * `--remap-path-prefix=$REPO=/papercusp` that scrubs build-box paths out of shipped
 * binaries. So the documented `REPO_ROOT=<pinned> build-desktop-sidecar.sh` yielded a
 * bundle whose JavaScript came from the pinned tree and whose Rust came from the live one,
 * while the release stamp claimed the pin for all of it.
 *
 * WHY IT NEEDS A GUARD rather than just a fix: it fails SILENTLY and PARTIALLY. Both roots
 * are real checkouts, every path resolves, every step succeeds, there is no error to
 * notice — the only evidence is bytes whose provenance blends two commits, which is the
 * exact thing the release audit exists to prevent and the exact thing it cannot see. The
 * workaround that shipped r15 relocated the WHOLE invocation (running the script copy
 * inside the pinned worktree), so the two roots agreed by accident and the documented
 * override was never exercised.
 *
 * TWO INDEPENDENT HALVES, because either alone passes while the defect is live:
 *   1. BEHAVIOUR — the extracted resolver honours the override, canonicalises it, treats
 *                  a blank one as absent, and never kills its caller.
 *   2. WIRING    — the producer uses that ONE resolved root for `REPO` too, and carries no
 *                  second independent recompute. A correct resolver that the chat-dock
 *                  section bypasses fixes nothing at all.
 *
 * A CONTROL CASE runs beside the behavioural ones: with NO override the resolver must
 * still return `<desktop_root>/..`. Without it, a resolver that returned some fixed path
 * would satisfy the override assertions while breaking every ordinary build.
 *
 * FALSIFIABILITY. Both subject paths are env-overridable
 * (`PAPERCUSP_SOURCE_ROOTS_HELPER_PATH`, `PAPERCUSP_SOURCE_ROOTS_PRODUCER_PATH`) so
 * `scripts/mutation-probe.sh` can aim this suite at a MUTATED COPY outside the tree — the
 * copy-out tier — instead of mutating the shared checkout, where a git-sync sweep can
 * commit the mutant even when nothing goes wrong. See CLAUDE.md "Proving a guard is
 * falsifiable".
 *
 * Run:
 *   node scripts/test-files.mjs packages/operator-core/lib/sidecar-source-root-coherence.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
  process.env.PAPERCUSP_SOURCE_ROOTS_HELPER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'source-roots.sh');
const PRODUCER_PATH =
  process.env.PAPERCUSP_SOURCE_ROOTS_PRODUCER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');

/** Comments never count — a rule that a comment can satisfy is not a rule. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Source the helper and call it exactly as the producer does: under `set -euo pipefail`,
 * in a command substitution. If the resolver can kill a build before its own named guards
 * get to report a bad root, this is where that shows up — the call is the last statement,
 * so a non-zero exit propagates and execFileSync throws.
 */
function callResolver(
  desktopRoot: string,
  env: Record<string, string | undefined>,
  extraArg?: string,
): string {
  const script = extraArg
    ? `set -euo pipefail\n. "$1"\npapercusp_repo_root "$2" "$3"\n`
    : `set -euo pipefail\n. "$1"\npapercusp_repo_root "$2"\n`;
  const clean = { ...process.env } as Record<string, string | undefined>;
  delete clean.REPO_ROOT;
  return execFileSync(
    'bash',
    ['-c', script, 'source-roots-guard', HELPER_PATH, desktopRoot, extraArg ?? ''],
    {
      encoding: 'utf8',
      env: { ...clean, ...env } as NodeJS.ProcessEnv,
      // WI-41180: a sync spawn blocks the worker's event loop, so vitest cannot time it
      // out, and the pure lane shares one fork across ~2,740 files — an unbounded hang
      // here wedges all of them until the batch watchdog fires 45 minutes later.
      timeout: 30_000,
      killSignal: 'SIGKILL',
    },
  ).trim();
}

describe('EI-21832562420831737 — the sidecar build resolves ONE source root, and honours it everywhere', () => {
  let work: string;
  /** Stands in for the live shared checkout: <live>/papercusp-desktop is the script root. */
  let live: string;
  let liveDesktop: string;
  /** Stands in for the pinned, tracked-clean release worktree. */
  let pinned: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'source-root-guard-'));
    live = join(work, 'live-tree');
    liveDesktop = join(live, 'papercusp-desktop');
    pinned = join(work, 'pinned-tree');
    mkdirSync(liveDesktop, { recursive: true });
    mkdirSync(pinned, { recursive: true });
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('the resolver exists — it is the extracted seam this guard tests', () => {
    expect(existsSync(HELPER_PATH), `expected the source-root resolver at ${HELPER_PATH}`).toBe(
      true,
    );
  });

  // ── 1. BEHAVIOUR ────────────────────────────────────────────────────────────
  it('honours a REPO_ROOT override — the pinned-source cut this item exists for', () => {
    const resolved = callResolver(liveDesktop, { REPO_ROOT: pinned });

    expect(resolved).toBe(pinned);
    // Stated separately because THIS is the regression: half the build kept resolving
    // back to the live tree while the stamp claimed the pin.
    expect(resolved).not.toBe(live);
  });

  it('canonicalises the root, so no consumer receives a `…/papercusp-desktop/..` path', () => {
    // The value reaches --remap-path-prefix and every error message; an un-normalised
    // path there is a latent mismatch, not a cosmetic one.
    expect(callResolver(liveDesktop, { REPO_ROOT: join(pinned, 'nested', '..') })).toBe(pinned);
    expect(callResolver(liveDesktop, { REPO_ROOT: undefined })).toBe(live);
  });

  // ── 2. CONTROL: the un-overridden path must keep its ordinary behaviour ──────
  // Without this, a resolver that returned a fixed path would satisfy every override
  // assertion above while breaking every developer/dogfood build.
  it('CONTROL — with no override it resolves <desktop_root>/.. (ordinary builds unchanged)', () => {
    expect(callResolver(liveDesktop, {})).toBe(live);
  });

  it('treats a blank/whitespace-only override as absent, never relocating the build to /', () => {
    expect(callResolver(liveDesktop, { REPO_ROOT: '' })).toBe(live);
    expect(callResolver(liveDesktop, { REPO_ROOT: '   ' })).toBe(live);
  });

  it('echoes an unusable root back instead of killing the caller', () => {
    // The producer has NAMED guards for this ("papercup/apps/operator not found at <path>
    // — Set REPO_ROOT to the path of your clone"). Exiting inside the resolver would move
    // that failure ~200 lines earlier and lose the diagnosis.
    const missing = join(work, 'no-such-tree');
    expect(callResolver(liveDesktop, { REPO_ROOT: missing })).toBe(missing);
  });

  it('accepts an explicit override argument, so the resolver is drivable without the env', () => {
    expect(callResolver(liveDesktop, { REPO_ROOT: live }, pinned)).toBe(pinned);
  });

  // ── 3. WIRING: a correct resolver the chat-dock section bypasses fixes nothing ──
  describe('build-desktop-sidecar.sh uses that one root for REPO as well', () => {
    let producer: string;

    beforeAll(() => {
      producer = codeOnly(readFileSync(PRODUCER_PATH, 'utf8'));
    });

    it('sources lib/source-roots.sh', () => {
      expect(producer).toMatch(/(?:^|\s)(?:source|\.)\s+"\$HERE\/lib\/source-roots\.sh"/m);
    });

    it('assigns REPO_ROOT from papercusp_repo_root', () => {
      expect(producer).toMatch(/REPO_ROOT="\$\(\s*papercusp_repo_root\s+"\$ROOT"\s*\)"/);
    });

    it('assigns REPO from REPO_ROOT rather than re-deriving it', () => {
      expect(producer).toMatch(/^\s*REPO="\$REPO_ROOT"\s*$/m);
    });

    it('carries NO second independent repo-root recompute (the reverted shape)', () => {
      const recomputes = producer
        .split('\n')
        .filter((line) => /cd\s+"\$ROOT\/\.\."\s*&&\s*pwd/.test(line));
      expect(recomputes).toEqual([]);
    });

    it('still reads the chat-dock sources through $REPO — the fix must not orphan it', () => {
      // Guards the degenerate "fix" of deleting REPO: the assertions above would all pass
      // against a producer that no longer builds pui at all.
      for (const path of ['$REPO/apps/tui', '$REPO/apps/pui-zellij-plugin']) {
        expect(producer, `expected the producer to still build from ${path}`).toContain(path);
      }
      expect(producer).toMatch(/--remap-path-prefix=\$REPO=/);
    });
  });
});
