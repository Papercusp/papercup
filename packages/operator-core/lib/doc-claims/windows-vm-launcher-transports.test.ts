/**
 * Pins the Windows VM rig's DISPLAY TRANSPORTS, and pins the deployed copy of its
 * launcher to the tracked one.
 *
 * WHY THIS EXISTS (WI-1716951, 2026-08-31). `launch-install.sh` began life as an
 * unattended-INSTALL harness where VNC was the automation transport, so it carried
 * only `-vnc 127.0.0.1:9`. On 2026-08-20 it was promoted to the PERMANENT rig behind
 * `papercup-vm-win.service`, and the documented owner-facing SPICE :5931 died with the
 * promotion. NOTHING FAILED LOUDLY — the VM booted, SSH worked, only the human's viewer
 * transport was gone. It stayed broken for 11 days for one structural reason: the
 * launcher lived at `/mnt/data/offload/windows-vm/`, OUTSIDE the repo, so no diff, no
 * review and no git-sync ever saw the change.
 *
 * The cost was not the missing port. An agent verified the live rig, correctly recorded
 * "Display is VNC 5909, NOT SPICE 5931" as a durable memory, and that memory then
 * surfaced 23 times and steered every later agent to the regressed transport — until
 * the owner asked why an agent had opened TigerVNC. A silent infrastructure regression
 * got laundered into a confident, load-bearing "fact". That is the failure mode this
 * guard exists to make impossible to repeat quietly.
 *
 * WHY A DRIFT PIN AND NOT A SYMLINK. The derived-truth ladder
 * (/internal/docs/agent-insights/derived-truth-ladder) prefers rung 1 (DERIVE — one
 * file, symlinked, cannot diverge) over rung 2 (PIN — two files, guarded). Rung 1 is
 * deliberately NOT taken here: symlinking the deployed launcher into this shared tree
 * would put a 16 GB VM's ability to boot at the mercy of ~100 agents' in-flight edits
 * and of git-sync, which commits the WHOLE tree on a schedule including broken
 * intermediates. A mid-refactor sweep would become a boot loop (the unit is
 * Restart=always). The failure being fixed is "a change nobody could SEE", which a
 * divergence check answers completely, so we buy visibility without buying fragility.
 *
 * SCOPE. The transport assertions read the TRACKED copy and always run. The drift
 * assertion needs the deployed copy and SKIPS where it is absent (any machine that is
 * not this rig's host), so this can never red the gate elsewhere.
 *
 * DERIVED, NOT HAND-MAINTAINED: the deployed path is read out of the script's own `cd`
 * line rather than written here, so relocating the rig re-derives this guard instead of
 * stranding it pointing at a path that no longer exists.
 *
 * Every rule below keeps a permanent CONTROL proving the detector can still fail
 * (CLAUDE.md's mutation-probe rule, "a module you import" tier — fixtures in-file, never
 * a mutation of the real tree, which git-sync would commit).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TRACKED_RELPATH = 'papercusp-desktop/scripts/windows-vm/launch-install.sh';
/**
 * Overridable so the absent-launcher branch below can be PROVEN without mutating the
 * shared tree — CLAUDE.md's tier-2 mutation-probe pattern ("make the test's subject path
 * overridable; that one line is what makes tier 2 available at all"). Mutating a tracked
 * file to prove a guard is unsafe here: the git-sync sweep can commit the mutant even when
 * nothing goes wrong and no handler fails.
 */
const TRACKED_PATH = process.env.WINDOWS_VM_LAUNCHER_PATH ?? join(REPO_ROOT, TRACKED_RELPATH);

const EXEC_LINE = 'exec qemu-system-x86_64';

/**
 * The deployed launcher's directory, read from the script's own `cd` line.
 * Deriving it means a rig that moves cannot leave this guard silently pointing at a
 * path that no longer exists — which would make the drift check pass vacuously.
 */
function deployedDirFrom(script: string): string | null {
  const m = script.match(/^cd\s+(\/\S+)\s*$/m);
  return m ? m[1] : null;
}

/**
 * The backslash-continued argv of the final `exec`, as the shell would see it.
 *
 * A comment line INSIDE a backslash continuation terminates it, so qemu launches with
 * every later argument silently DROPPED — valid syntax, `bash -n` clean. That is
 * precisely how `-spice`/`-monitor`/`-display` were lost from the linux-test-vm rig on
 * 2026-07-09. Returning the continuation's own extent is what lets us assert the tail
 * is still reachable rather than merely that the text appears somewhere in the file.
 */
function execContinuation(script: string): { lines: string[]; commentsInside: string[] } {
  const all = script.split('\n');
  const start = all.findIndex((l) => l.startsWith(EXEC_LINE));
  if (start === -1) return { lines: [], commentsInside: [] };

  const lines: string[] = [];
  const commentsInside: string[] = [];
  for (let i = start; i < all.length; i++) {
    const line = all[i];
    if (line.trim().startsWith('#')) commentsInside.push(line.trim());
    lines.push(line);
    if (!line.trimEnd().endsWith('\\')) break; // continuation ended here
  }
  return { lines, commentsInside };
}

/**
 * READ DEFENSIVELY, AND AT MODULE SCOPE ONLY BECAUSE IT CANNOT THROW HERE.
 *
 * The tracked launcher lives in the `papercusp-desktop` SUBMODULE, and the superproject
 * advances that gitlink in its OWN commit — a separate one from the commit carrying this
 * file. So a perfectly ordinary checkout can legitimately lack the launcher: the release
 * and checkpoint trees on this box both do right now, and so does any gate candidate cut
 * in the window between this test landing (315e70b0, 12:32:20Z) and the gitlink bump that
 * follows it (5a45c574). This is not a defect in the launcher and must not be reported as
 * one.
 *
 * A bare `readFileSync` here made that ordinary state throw ENOENT during COLLECTION,
 * which fails the whole FILE rather than one test — and a multi-file vitest invocation can
 * abort collection outright when one file's module graph crashes (CLAUDE.md, gate-failure
 * triage). That is a fleet-wide red produced by a checkout state nobody did wrong.
 *
 * The invariant this file guards is conditional by nature: IF the tracked launcher is in
 * this checkout, THEN it declares both transports and the deployed copy matches it. So
 * absence SKIPS — via `describe.skipIf`, which keeps the skip VISIBLE in the run output
 * instead of letting the suite pass vacuously. Existence of the launcher is the
 * papercusp-desktop repo's invariant to hold, not this one's.
 */
const TRACKED_RAW = existsSync(TRACKED_PATH) ? readFileSync(TRACKED_PATH, 'utf8') : null;
const NO_TRACKED = TRACKED_RAW === null;
const NO_TRACKED_REASON =
  `${TRACKED_RELPATH} is absent from this checkout (the papercusp-desktop gitlink ` +
  'predates it) — nothing to drift-check here';
// Never observed: both describes below are skipped when NO_TRACKED. Keeping the type
// `string` is what lets every assertion below stay unchanged.
const TRACKED = TRACKED_RAW ?? '';

// ── Controls. Fixtures, never the real tree — a probe that mutates a tracked file can
// be committed by the git-sync sweep even when nothing goes wrong (CLAUDE.md).
const CONTROL_TRUNCATED = [
  'cd /some/rig/dir',
  'exec qemu-system-x86_64 \\',
  '  -netdev user,id=net0 \\',
  '  # a comment here ends the continuation',
  '  -spice port=5931,addr=127.0.0.1,disable-ticketing=on \\',
  '  -boot order=dc',
  '',
].join('\n');

const CONTROL_VNC_ONLY = [
  'cd /some/rig/dir',
  'exec qemu-system-x86_64 \\',
  '  -vnc 127.0.0.1:9 \\',
  '  -display none \\',
  '  -boot order=dc',
  '',
].join('\n');

// The rig runs WSL2 inside Hyper-V inside KVM, not merely a Windows guest.
// QEMU does not enable Hyper-V enlightenments for a bare "-cpu host".
// Inspect the reachable exec argv, not comments that mention the desired flags.
function nestedHypervProfile(script: string): Set<string> {
  const argv = execContinuation(script).lines.join(' ');
  const cpu = argv.match(/(?:^|\s)-cpu\s+([^\s\\]+)/)?.[1] ?? '';
  return new Set(cpu.split(','));
}

describe.skipIf(NO_TRACKED)('windows-vm launcher: nested Hyper-V profile', () => {
  const required = [
    'host', 'hv-vpindex', 'hv-vapic', 'hv-time', 'hv-synic',
    'hv-stimer', 'hv-stimer-direct', 'hv-tlbflush', 'hv-ipi',
  ];

  it('exposes nested direct timers and their dependencies', () => {
    const profile = nestedHypervProfile(TRACKED);
    for (const flag of required) expect(profile.has(flag), flag).toBe(true);
  });

  it('preserves watchdogs and does not enable Intel-only eVMCS on AMD', () => {
    const profile = nestedHypervProfile(TRACKED);
    expect([...profile].some((flag) => /^hv-relaxed(?:=|$)/.test(flag))).toBe(false);
    expect([...profile].some((flag) => /^hv-evmcs(?:=|$)/.test(flag))).toBe(false);
  });

  it('CONTROL: bare host fails even when comments name every required feature', () => {
    const control = `# ${required.join(',')}\nexec qemu-system-x86_64 -cpu host`;
    expect(required.every((flag) => nestedHypervProfile(control).has(flag))).toBe(false);
  });

  it('CONTROL: removal of direct mode is detected separately from classic timers', () => {
    const control = `exec qemu-system-x86_64 -cpu ${required.filter((flag) =>
      flag !== 'hv-stimer-direct').join(',')}`;
    expect(nestedHypervProfile(control).has('hv-stimer')).toBe(true);
    expect(nestedHypervProfile(control).has('hv-stimer-direct')).toBe(false);
  });
});

describe.skipIf(NO_TRACKED)(`windows-vm launcher: display transports are pinned${
  NO_TRACKED ? ` [SKIPPED: ${NO_TRACKED_REASON}]` : ''
}`, () => {
  it('serves the owner-facing SPICE transport', () => {
    const { lines } = execContinuation(TRACKED);
    const argv = lines.join('\n');
    expect(argv, `${TRACKED_RELPATH} lost -spice: the owner-facing viewer transport`).toContain(
      '-spice port=5931,addr=127.0.0.1,disable-ticketing=on',
    );
  });

  it('keeps the VNC transport the install/automation tooling drives', () => {
    const { lines } = execContinuation(TRACKED);
    expect(lines.join('\n')).toContain('-vnc 127.0.0.1:9');
  });

  it('CONTROL: a VNC-only launcher is caught (this is the 2026-08-20 regression)', () => {
    const { lines } = execContinuation(CONTROL_VNC_ONLY);
    expect(lines.join('\n')).not.toContain('-spice');
  });

  it('has no comment inside the exec continuation', () => {
    const { commentsInside } = execContinuation(TRACKED);
    expect(
      commentsInside,
      'a comment inside a backslash continuation silently DROPS every later qemu arg',
    ).toEqual([]);
  });

  it('CONTROL: a comment inside the continuation is caught, and truncates the argv', () => {
    const { commentsInside, lines } = execContinuation(CONTROL_TRUNCATED);
    expect(commentsInside.length).toBeGreaterThan(0);
    // The detector must also observe the CONSEQUENCE, not just the comment: the
    // continuation stops at the comment, so -spice and the tail never reach qemu.
    expect(lines.join('\n')).not.toContain('-boot order=dc');
    expect(lines.join('\n')).not.toContain('-spice');
  });

  it('the continuation still reaches its tail', () => {
    const { lines } = execContinuation(TRACKED);
    expect(lines.join('\n'), 'argv is truncated before the final argument').toContain(
      '-boot order=dc',
    );
  });

  it('hardcodes no home path (identity-lint reds the gate and freezes main fleet-wide)', () => {
    expect(TRACKED).not.toMatch(/\/home\/[a-z][a-z0-9_-]*\//i);
  });
});

describe.skipIf(NO_TRACKED)(`windows-vm launcher: deployed copy has not drifted from the tracked one${
  NO_TRACKED ? ` [SKIPPED: ${NO_TRACKED_REASON}]` : ''
}`, () => {
  const deployedDir = deployedDirFrom(TRACKED);

  it('the tracked script still declares where it deploys', () => {
    expect(
      deployedDir,
      'no `cd <abs path>` line — the drift check below would silently no-op',
    ).toBeTruthy();
  });

  it('deployed launcher is byte-identical to the tracked one', () => {
    if (!deployedDir) return; // asserted above; nothing coherent to compare
    const deployedPath = join(deployedDir, 'launch-install.sh');
    if (!existsSync(deployedPath)) {
      // Not this rig's host. The transport assertions above already ran against the
      // tracked copy, so skipping here loses no coverage that this machine could give.
      return;
    }
    const deployed = readFileSync(deployedPath, 'utf8');
    expect(
      deployed,
      `${deployedPath} has diverged from ${TRACKED_RELPATH}. The tracked copy is canonical: ` +
        'reconcile them. An unreviewed edit to the deployed copy is exactly how SPICE ' +
        'vanished for 11 days (WI-1716951).',
    ).toBe(TRACKED);
  });
});
