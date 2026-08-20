/**
 * release-identity-gate-ordering.test.ts — regression guard for EI-20304355477263736.
 *
 * THE DEFECT THIS PINS. The release cut runs the identity scanner
 * (papercusp-desktop/bin/audit-release-bundle.py --scan-dir) three times: once on
 * the assembled sidecar, once on the fully-staged bundle, and once per platform leg
 * on the packaged AppDir/.app. The scanner was never the problem — its POSITION was.
 * It used to run in the middle of build-desktop-sidecar.sh, with 44 further
 * cp/mkdir/cat writes into $SIDECAR_DIR below it, and before release-local.sh's
 * stage-env-sidecars.sh / stage-source-tree.sh had written anything at all. So the
 * "early" scan covered 10,635 file(s) / 0 archive(s) while the per-leg gate covered
 * 17,560 / 3 (both figures from the 0.0.16-alpha attempt-5 cut log, via
 * EI-20304355477263736) — two gates of unequal scope in a fixed order, cheap one first.
 *
 * 0.0.16-alpha attempt 5 (2026-08-13) paid for that: an owner handle in a RETIRED
 * blueprint's YAML comment landed in sidecar/harness/** and
 * sidecar/env-sidecars/staging/harness/**, both written AFTER the early scan, and
 * was caught by the per-leg gate ~40 minutes in — after four parallel Rust builds.
 * Running the repositioned gate's exact command against that same tree (measured
 * 2026-08-13) covers 17,559 file(s) / 3 archive(s) in 136s — one file off the leg.
 *
 * WHAT THIS TEST ENFORCES — the ORDERING invariant, not the scanner:
 *   1. release-local.sh's assembled-bundle gate runs AFTER every bin/stage-*.sh
 *      call (they write into the bundle) and BEFORE the first platform leg launches.
 *   2. build-desktop-sidecar.sh's release scan is the LAST thing that touches
 *      payload bytes in $SIDECAR_DIR. The sole permitted post-scan write is the
 *      fixed-schema success attestation in .sidecar-build-stamp; nothing is copied
 *      in after the scan.
 *   3. Every gate uses the SAME scanner (audit-release-bundle.py --scan-dir), so a
 *      second, drifting identity rule cannot appear.
 *
 * Each rule is a pure function checked against BOTH the real script and a synthetic
 * violating fixture, so the assertions cannot pass by going inert: if the extractor
 * stops matching, the control case fails.
 *
 * Static assertions over the shell scripts — a real cut is a ~40 minute tri-platform
 * build that cannot run in a unit test. Run:
 *   cd packages/operator-core && npx vitest run lib/release-identity-gate-ordering.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'release-local.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the repo root (no papercusp-desktop/bin/release-local.sh above this test)');
}

const DESKTOP_BIN = join(repoRoot(), 'papercusp-desktop', 'bin');
const readScript = (name: string) => readFileSync(join(DESKTOP_BIN, name), 'utf8');

/** Lines are 1-indexed to match what an editor shows, and comments never count. */
function codeLines(src: string): { n: number; text: string }[] {
  return src
    .split('\n')
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => !/^\s*#/.test(l.text));
}

const findLines = (src: string, re: RegExp): number[] =>
  codeLines(src)
    .filter((l) => re.test(l.text))
    .map((l) => l.n);

/** The assembled-bundle identity gate: the scanner pointed at the staged sidecar. */
const GATE_RE = /audit-release-bundle\.py"?\s+--scan-dir\s+"\$ROOT\/src-tauri\/sidecar"/;
/** Any staging step that writes into the bundle. */
const STAGING_RE = /bash\s+"\$ROOT\/bin\/stage-[a-z-]+\.sh"/;
/** The first platform leg — the ~40 minutes of build the gate must precede. */
const LEG_RE = /\[parallel\]\s+launching Linux|npx --yes -p @tauri-apps\/cli/;

/**
 * Writes into the assembled sidecar. Deliberately verb-anchored (cp/mkdir/install/
 * tar/ln/mv/cat-redirect) rather than "any mention of $SIDECAR_DIR": the scan line
 * itself and the closing `du -sh` mention the directory without writing to it, and a
 * check that flagged those could only be satisfied by moving the scan somewhere it
 * does not belong.
 */
const SIDECAR_WRITE_RE =
  /(?:^|[|;&(]|\s)(?:cp|mkdir|install|tar|ln|mv|rsync|chmod|touch)\s[^\n]*\$(?:SIDECAR_DIR|HARNESS_DST)|>\s*"\$(?:SIDECAR_DIR|HARNESS_DST)/;
const SIDECAR_SCAN_RE = /audit-release-bundle\.py"?\s+--scan-dir\s+"\$SIDECAR_DIR"/;
const SIDECAR_AUDIT_ATTEST_RE = /stamp\.releaseIdentityAudit\s*=\s*\{/;

/** Bundled resource roots (from tauri.conf.json) the gate's argument list does NOT scan. */
const unscannedRoots = (gateLine: string, roots: string[]): string[] =>
  roots.filter((root) => !gateLine.includes(`"$ROOT/src-tauri/${root}"`));

describe('release-local.sh: the assembled-bundle identity gate is positioned to be scope-identical to the per-leg gate', () => {
  const src = readScript('release-local.sh');

  it('exists exactly once, and is fail-closed', () => {
    const gate = findLines(src, GATE_RE);
    expect(gate, 'the assembled-bundle identity gate is missing from release-local.sh').toHaveLength(1);
    // The scan must gate the cut, not merely report: `if ! python3 … ; then … exit 1`.
    const window = src.split('\n').slice(gate[0] - 1, gate[0] + 6).join('\n');
    expect(window, 'the gate must be fail-closed (if ! … exit 1)').toMatch(/^if !/m);
    expect(window, 'the gate must exit non-zero on a leak').toMatch(/exit 1/);
  });

  it('covers EVERY bundled resource root declared in tauri.conf.json — scope parity is derived, not remembered', () => {
    // The defect was two gates of unequal SCOPE. Pinning the gate's argument list to
    // the bundle manifest is what makes parity structural: add a third resource root
    // to tauri.conf.json and this fails until the gate covers it too, instead of the
    // hole being discovered 40 minutes into a cut by the per-leg scan.
    const conf = JSON.parse(
      readFileSync(join(repoRoot(), 'papercusp-desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'),
    ) as { bundle?: { resources?: string[] } };
    const roots = [...new Set((conf.bundle?.resources ?? []).map((g) => g.split('/')[0]))];
    expect(roots.length, 'tauri.conf.json declares no bundle.resources').toBeGreaterThan(0);
    const gateLine = src.split('\n')[findLines(src, GATE_RE)[0] - 1];
    expect(
      unscannedRoots(gateLine, roots),
      'tauri.conf.json bundles resource root(s) the assembled-bundle identity gate does not scan — ' +
        'those bytes ship unscanned until the per-leg gate sees them 40 minutes later (EI-20304355477263736)',
    ).toEqual([]);
    // Control: the same check must FLAG a gate that dropped a root, or it proves nothing.
    expect(unscannedRoots('--scan-dir "$ROOT/src-tauri/sidecar"', ['sidecar', 'resources'])).toEqual([
      'resources',
    ]);
  });

  it('runs AFTER every bin/stage-*.sh call — a staging step added below it would re-open the gap', () => {
    const gate = findLines(src, GATE_RE)[0];
    const staging = findLines(src, STAGING_RE);
    expect(staging.length, 'expected release-local.sh to invoke at least one bin/stage-*.sh').toBeGreaterThan(0);
    const afterGate = staging.filter((n) => n > gate);
    expect(
      afterGate,
      `bin/stage-*.sh runs at line(s) ${afterGate.join(', ')} — AFTER the identity gate at line ${gate}. ` +
        'Whatever those steps write into src-tauri/sidecar is invisible to the gate, which is exactly the ' +
        'EI-20304355477263736 defect (it cost 0.0.16-alpha a full cut). Move the gate below them.',
    ).toEqual([]);
  });

  it('runs BEFORE the first platform leg launches', () => {
    const gate = findLines(src, GATE_RE)[0];
    const legs = findLines(src, LEG_RE);
    expect(legs.length, 'expected release-local.sh to launch a Linux leg').toBeGreaterThan(0);
    expect(
      Math.min(...legs),
      `the identity gate (line ${gate}) must precede the first leg launch (line ${Math.min(...legs)}) — ` +
        'the whole point is failing in seconds instead of after ~40 minutes of Rust builds',
    ).toBeGreaterThan(gate);
  });

  it('control: the ordering check FAILS on a script whose staging step runs after the gate', () => {
    const violating = [
      'bash "$ROOT/bin/build-desktop-sidecar.sh"',
      'python3 "$ROOT/bin/audit-release-bundle.py" --scan-dir "$ROOT/src-tauri/sidecar"',
      'bash "$ROOT/bin/stage-env-sidecars.sh"',
      'echo "==> [parallel] launching Linux x86_64 build"',
    ].join('\n');
    const gate = findLines(violating, GATE_RE)[0];
    const staging = findLines(violating, STAGING_RE);
    expect(gate).toBeDefined();
    expect(staging.filter((n) => n > gate)).not.toEqual([]);
  });
});

describe('build-desktop-sidecar.sh: the release identity scan is the last word on sidecar payload', () => {
  const src = readScript('build-desktop-sidecar.sh');

  it('scans the assembled sidecar, release-gated', () => {
    const scan = findLines(src, SIDECAR_SCAN_RE);
    expect(scan, 'the assembled-sidecar identity scan is missing').toHaveLength(1);
    const window = src.split('\n').slice(Math.max(0, scan[0] - 4), scan[0] + 4).join('\n');
    expect(window, 'the scan must stay release-gated (PAPERCUSP_RELEASE_AUDIT)').toMatch(/PAPERCUSP_RELEASE_AUDIT/);
    expect(window, 'the scan must be fail-closed').toMatch(/exit 1/);
  });

  it('has NO further payload write into $SIDECAR_DIR below it', () => {
    const scan = findLines(src, SIDECAR_SCAN_RE)[0];
    const writesAfter = findLines(src, SIDECAR_WRITE_RE).filter((n) => n > scan);
    expect(
      writesAfter,
      `line(s) ${writesAfter.join(', ')} write into the sidecar AFTER the identity scan at line ${scan}. ` +
        'Anything copied in below the scan ships unscanned by it — the exact shape that let a leaked owner ' +
        'handle reach sidecar/harness/** unseen (EI-20304355477263736). Move the scan below the last write.',
    ).toEqual([]);
  });

  it('writes only a fixed-schema success attestation after the scan passes', () => {
    const scan = findLines(src, SIDECAR_SCAN_RE)[0];
    const attest = findLines(src, SIDECAR_AUDIT_ATTEST_RE);
    expect(attest, 'the final identity scan must leave a consumer-verifiable attestation').toHaveLength(1);
    expect(attest[0], 'an attestation written before the scan would attest intent, not success').toBeGreaterThan(scan);
    const window = src.split('\n').slice(attest[0] - 1, attest[0] + 8).join('\n');
    expect(window).toMatch(/schemaVersion:\s*1/);
    expect(window).toMatch(/passed:\s*true/);
    expect(window).toMatch(/scanner:\s*'audit-release-bundle\.py --scan-dir'/);
    expect(window).toMatch(/fs\.renameSync\(tmpPath, stampPath\)/);
  });

  it('control: the write-after-scan check FAILS on a script that copies in after scanning', () => {
    const violating = [
      'python3 "$HERE/audit-release-bundle.py" --scan-dir "$SIDECAR_DIR"',
      'cp -a "$WEB_DIR/prompts" "$SIDECAR_DIR/prompts"',
    ].join('\n');
    const scan = findLines(violating, SIDECAR_SCAN_RE)[0];
    expect(scan).toBeDefined();
    expect(findLines(violating, SIDECAR_WRITE_RE).filter((n) => n > scan)).not.toEqual([]);
  });
});

describe('one identity rule, three positions', () => {
  it('every release identity gate calls the same scanner — no second, drifting rule', () => {
    for (const [script, re] of [
      ['release-local.sh', GATE_RE],
      ['build-desktop-sidecar.sh', SIDECAR_SCAN_RE],
      ['build-appimage.sh', /--scan-dir\s+"\$APPDIR"/],
    ] as const) {
      expect(findLines(readScript(script), re).length, `${script} lost its --scan-dir gate`).toBeGreaterThan(0);
    }
  });
});
