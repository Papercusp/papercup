/**
 * live-federation-gate-disk-capacity-downgrade.test.ts — regression guard for WI-10000053.
 *
 * THE BUG: `lib/disk-preflight.sh` is an ADMISSION control. When the staging target lacks
 * headroom it refuses with the dedicated rc28 (ENOSPC) BEFORE any compilation happens. The gate
 * invoked the sidecar builder as `... || { FAIL_BUILD=1; ... }`, which captures "non-zero" and
 * DISCARDS the code — so an admission refusal where nothing was built was indistinguishable from
 * a genuine compile failure. It became `REDS+=("sidecar-build")`, which
 *   (a) armed the 6h code-red backoff (GATE_RED_TTL_H) whose premise is "re-running unchanged
 *       code reproduces it at full cost" — false when no code was run at all, and
 *   (b) filed a "sidecar-build failed on the packaged binary" PRODUCT bug for a binary that was
 *       never built.
 *
 * MEASURED 2026-09-20 (the filing evidence): runs 04:21:23Z and 04:34:57Z banked
 * `build=FAIL` / `local_matrix=SKIPPED-CONTENT-RED` with every other leg SKIPPED, on
 * "5GB effectively free, need ~8GB" — 13GB free less 8GB reserved by concurrent in-flight
 * builds. `last-red` was stamped 04:35:00Z, and the following five windows short-circuited to
 * `GATE: FRESH-RED (red Nh ago ...)` with all four legs unmeasured (`'?'`). Because the rig only
 * writes a non-empty `certification_target_sha` on a GREEN, `release:deploy` stayed fail-closed
 * on `liveCertification.certified !== true` for the whole window.
 *
 * THE FIX: a fourth sibling in the existing evidence-producer classifier family
 * (`build_lock_contention_check` / `build_dependency_contention_check` /
 * `source_lock_contention_check`). A confirmed capacity refusal takes the SAME downgrade shape
 * those three already take: stamp `last-downgrade` (short retry TTL), clear `last-red`, never
 * touch `last-green`, file nothing — because a capacity refusal is ENVIRONMENTAL and clears on
 * its own the moment the concurrent builds release their reservation.
 *
 * STATIC leg: pins the cross-file rc28 contract (the load-bearing assumption — if the builder
 * stops propagating the code, the classifier silently never fires), the rc-capture ordering, and
 * the downgrade-shaped consumption.
 * BEHAVIORAL leg: evals the REAL classifier out of the shipping script under bash, including a
 * permanent WRONG-IMPLEMENTATION control proving the guard is not vacuous.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-disk-capacity-downgrade.test.ts
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'live-federation-gate.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/live-federation-gate.sh above this test)',
  );
}

const ROOT = repoRoot();
// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY outside the
// tree (tier 2), so proving the guard falsifiable never dirties the shared checkout.
const GATE_PATH =
  process.env.PROBE_SCRIPT || join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const gate = readFileSync(GATE_PATH, 'utf8');

const BUILDER_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');
const PREFLIGHT_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'disk-preflight.sh');

/** Extract a multi-line shell function whose closing `}` sits at column 0. */
function extractFn(name: string): string {
  const m = gate.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n^\\}$`, 'm'));
  expect(m?.[0], `could not extract ${name}() from the gate source`).toBeTruthy();
  return m![0];
}

const CLASSIFIER = extractFn('build_disk_capacity_check');

/**
 * Run the REAL classifier out of the shipping script against a scratch build log, and report
 * what BUILD_DISK_CAPACITY ended up as. `impl` lets the wrong-implementation control below
 * substitute a naive rule while reusing this identical harness.
 */
function runClassifier(
  rc: string,
  logBody: string | null,
  impl: string = CLASSIFIER,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'lfg-disk-cap-'));
  const logPath = join(dir, 'build.log');
  if (logBody !== null) writeFileSync(logPath, logBody);
  const script = [
    'set -u',
    'BUILD_DISK_CAPACITY=""',
    impl,
    `build_disk_capacity_check ${JSON.stringify(rc)} ${JSON.stringify(logPath)}`,
    'printf "%s" "$BUILD_DISK_CAPACITY"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(r.status, `classifier harness failed: ${r.stderr}`).toBe(0);
  return r.stdout;
}

// The canonical refusal, byte-for-byte from the 2026-09-20T04:34:57Z run's build.log.
const REAL_REFUSAL = [
  'NOTE: building WITHOUT a release identity audit (PAPERCUSP_RELEASE_AUDIT is not 1).',
  '→ using pinned Node runtime: /home/linuxbrew/.linuxbrew/bin/node (v25.9.0, required >=25)',
  'check-conflict-markers: clean — no committed git conflict markers',
  'ERROR: insufficient disk for sidecar staging: 5GB effectively free, need ~8GB.',
  '       Staging target: /w/papercusp-live-certification/papercusp-desktop/src-tauri/sidecar.tmp.3514248',
  '       13GB is free on disk, but 8GB is already RESERVED by other',
  '       in-flight builds on this filesystem, so starting now would over-commit it.',
  '       Wait for them to finish, or free space (stale cargo target dirs, old builds).',
].join('\n');

// A genuine compile failure — non-zero, but nothing to do with capacity.
const REAL_COMPILE_FAILURE = [
  '→ using Cargo toolchain: /opt/toolchain/cargo/bin/cargo',
  "error[E0425]: cannot find value `frobnicate` in this scope",
  'error: could not compile `papercusp-gui` (bin "papercusp-gui") due to 1 previous error',
].join('\n');

describe('live-federation gate: a disk-capacity admission refusal downgrades instead of banking a product RED', () => {
  // ── STATIC leg ──────────────────────────────────────────────────────────────
  //
  // This first assertion is the load-bearing one. The classifier keys off rc28, which is only
  // meaningful because two OTHER files agree to produce and propagate it. If either stops, the
  // classifier still parses, still runs, and simply never fires — the failure mode that makes a
  // guard look healthy while doing nothing.
  it('pins the cross-file ENOSPC contract: disk-preflight RETURNS 28 and the builder PROPAGATES it', () => {
    const preflight = readFileSync(PREFLIGHT_PATH, 'utf8');
    expect(
      /\breturn 28\b/.test(preflight),
      'disk-preflight.sh no longer returns 28 (ENOSPC) — build_disk_capacity_check can never fire',
    ).toBe(true);

    const builder = readFileSync(BUILDER_PATH, 'utf8');
    const call = /^papercusp_require_free_gb .*$/m.exec(builder)?.[0] ?? '';
    expect(call, 'could not find the papercusp_require_free_gb call in build-desktop-sidecar.sh').toBeTruthy();
    expect(
      call.includes('|| exit $?'),
      `the sidecar builder must preserve the preflight's exit code verbatim, got: ${call}`,
    ).toBe(true);
  });

  it('captures the build rc as the FIRST command of the || group (anything earlier clobbers $?)', () => {
    const invocation = /^.*bash bin\/build-desktop-sidecar\.sh \).*$/m.exec(gate)?.[0] ?? '';
    expect(invocation, 'could not find the sidecar build invocation').toBeTruthy();
    // `|| { BUILD_RC=$?; ... }` — BUILD_RC must be assigned before anything else in the group,
    // because even a successful assignment resets $? to 0.
    expect(invocation).toMatch(/\|\|\s*\{\s*BUILD_RC=\$\?;/);
  });

  it('requires BOTH the dedicated rc AND the canonical emitter line (unrelated failures stay RED)', () => {
    expect(CLASSIFIER).toMatch(/\[ "\$rc" = 28 \] \|\| return 0/);
    expect(CLASSIFIER).toMatch(/ERROR: insufficient disk for /);
  });

  it('consumes the flag with the downgrade shape its three siblings use, and before them', () => {
    const consumption =
      /if \[ -n "\$BUILD_DISK_CAPACITY" \]; then[\s\S]*?\n  fi/.exec(gate)?.[0] ?? '';
    expect(consumption, 'could not find the BUILD_DISK_CAPACITY consumption block').toBeTruthy();
    // Stamps the SHORT environmental retry, clears the long code-red backoff, exits non-green.
    expect(consumption).toContain('>"$STATE_DIR/last-downgrade"');
    expect(consumption).toContain('rm -f "$STATE_DIR/last-red"');
    expect(consumption).toContain('SKIPPED-BUILD-DISK-CAPACITY');
    expect(consumption).toMatch(/\bexit 0\b/);
    // Must NEVER refresh last-green: a skipped window is not a pass.
    expect(consumption).not.toContain('last-green');
    // It is inside the FAIL_BUILD branch, ahead of the lock-contention sibling.
    expect(gate.indexOf('if [ -n "$BUILD_DISK_CAPACITY" ]; then')).toBeGreaterThan(
      gate.indexOf('if [ "$FAIL_BUILD" = 1 ]; then'),
    );
    expect(gate.indexOf('if [ -n "$BUILD_DISK_CAPACITY" ]; then')).toBeLessThan(
      gate.indexOf('if [ -n "$BUILD_LOCK_CONTENTION" ]; then'),
    );
  });

  // ── BEHAVIORAL leg ──────────────────────────────────────────────────────────
  it('fires on the real refusal (rc28 + canonical line) and carries the detail forward', () => {
    const got = runClassifier('28', REAL_REFUSAL);
    expect(got).toContain('insufficient disk for sidecar staging');
    expect(got).toContain('5GB effectively free, need ~8GB');
    // The `ERROR: ` prefix is stripped so the verdict line reads cleanly.
    expect(got.startsWith('ERROR:')).toBe(false);
  });

  it('does NOT fire on rc28 without the canonical line (fails closed on RED)', () => {
    expect(runClassifier('28', REAL_COMPILE_FAILURE)).toBe('');
  });

  it('does NOT fire on a genuine compile failure whose log merely mentions the phrase', () => {
    // rc1 + a log that happens to quote the refusal (e.g. an echoed selftest assertion).
    expect(runClassifier('1', REAL_REFUSAL)).toBe('');
  });

  it('does NOT fire when the build log is missing entirely', () => {
    expect(runClassifier('28', null)).toBe('');
  });

  it('does NOT fire on success', () => {
    expect(runClassifier('0', REAL_REFUSAL)).toBe('');
  });

  // ── permanent WRONG-IMPLEMENTATION control ──────────────────────────────────
  //
  // Kept in the file forever rather than mutating the shared tree (the sweep race). The naive
  // rule — "the build failed, and the log mentions disk, so call it capacity" — is what this
  // guard is actually defending against: it would silently reclassify GENUINE compile failures
  // as environmental and stop filing them. If this pair ever stops diverging, the rc
  // requirement has been lost from the real classifier.
  const NAIVE_IMPL = `build_disk_capacity_check() {
  local rc="$1" log="$2" detail
  [ "$rc" = 0 ] && return 0
  [ -f "$log" ] || return 0
  detail="$(grep -aE '^ERROR: insufficient disk for ' "$log" 2>/dev/null | head -1 | sed 's/^ERROR: //')"
  [ -n "$detail" ] || return 0
  BUILD_DISK_CAPACITY="$detail"
}`;

  it('CONTROL: a naive rc-agnostic rule DIVERGES from the real one (the guard is not vacuous)', () => {
    // Calibration: on the case both agree about, they must actually agree — otherwise the
    // divergence below would prove nothing about the rc requirement specifically.
    expect(runClassifier('28', REAL_REFUSAL, NAIVE_IMPL)).toBe(runClassifier('28', REAL_REFUSAL));

    // The discriminating case: a non-capacity failure whose log quotes the phrase.
    const real = runClassifier('1', REAL_REFUSAL);
    const naive = runClassifier('1', REAL_REFUSAL, NAIVE_IMPL);
    expect(real).toBe('');
    expect(naive).not.toBe('');
    expect(real).not.toBe(naive);
  });
});
