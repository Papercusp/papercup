/**
 * papercusp-files.test.ts — resolveShimNode, the node-binary resolver the psu /
 * dispatcher CLI shims exec (writeShim + writeDispatcherShim).
 *
 * Regression guard for WI-3334: on a packaged dogfood install with NO system
 * node, the psu shim execed bare `node` → "node not found". The launcher
 * resolved into the EXTRACTED dev-source tree
 * (`<dev-source>/apps/operator/scripts/psu-launcher.mjs`), whose grandparent has
 * no `bin/node`, AND installPapercuspFiles does NOT run with cwd = the sidecar
 * dir — so BOTH the launcher-adjacent and the cwd anchor missed and the shim
 * fell back to bare `node` (confirmed live on the Linux dogfood VM). The fix adds
 * two cwd-independent anchors that both point at the bundled node regardless of
 * cwd: `$PAPERCUSP_SIDECAR_BIN/node` and `process.execPath`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveShimNode, ensureBundledNodeLinked, ensureGhLinked } from './papercusp-files';

let tmp: string;
let origExecPath: string;

/** Create an empty file (its parent dirs too) so fs.access / pathExists sees it. */
async function touch(p: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, '');
}
/** process.execPath is a writable string; override it (restored in afterEach). */
function setExecPath(p: string): void {
  process.execPath = p;
}
/** Neutralize the two cwd-independent anchors so a test can exercise the path anchors. */
function disableBundledAnchors(): void {
  vi.stubEnv('PAPERCUSP_SIDECAR_BIN', ''); // falsy → anchor 1 skipped
  setExecPath(path.join(tmp, 'no-such', 'notnode')); // basename !== node → anchor 2 skipped
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-node-'));
  origExecPath = process.execPath;
});
afterEach(async () => {
  setExecPath(origExecPath);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveShimNode', () => {
  it('anchor 1: uses $PAPERCUSP_SIDECAR_BIN/node when set and present (packaged canonical)', async () => {
    const sidecarBin = path.join(tmp, 'sidecar', 'bin');
    const bundled = path.join(sidecarBin, 'node');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', sidecarBin);
    setExecPath(path.join(tmp, 'other', 'node')); // exists=no; env anchor must win first anyway
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'elsewhere'));
    // Launcher lives in the extracted dev-source tree (no adjacent bin/node).
    const launcher = path.join(tmp, 'dev-source', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');

    expect(await resolveShimNode(launcher)).toBe(bundled);
  });

  it('anchor 2 (WI-3334): falls to process.execPath (the running bundled node) when SIDECAR_BIN is unset', async () => {
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', '');
    const bundled = path.join(tmp, 'sidecar', 'bin', 'node');
    await touch(bundled);
    setExecPath(bundled); // serve.mjs runs UNDER the bundled node
    // The exact regression layout: launcher in dev-source, cwd is NOT the sidecar.
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'somewhere-else'));
    const launcher = path.join(tmp, 'dev-source', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');

    expect(await resolveShimNode(launcher)).toBe(bundled);
  });

  it('prefers $PAPERCUSP_SIDECAR_BIN/node over process.execPath when both exist', async () => {
    const envNode = path.join(tmp, 'sidecar', 'bin', 'node');
    const execNode = path.join(tmp, 'other-node', 'node');
    await touch(envNode);
    await touch(execNode);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(envNode));
    setExecPath(execNode);
    const launcher = path.join(tmp, 'dev-source', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');

    expect(await resolveShimNode(launcher)).toBe(envNode);
  });

  it('anchor 3: uses the bundled node next to the launcher when the cwd-independent anchors are absent', async () => {
    disableBundledAnchors();
    const sidecar = path.join(tmp, 'sidecar');
    const launcher = path.join(sidecar, 'scripts', 'psu-launcher.mjs');
    const bundled = path.join(sidecar, 'bin', 'node');
    await touch(bundled);
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'elsewhere'));

    expect(await resolveShimNode(launcher)).toBe(bundled);
  });

  it('anchor 4: falls to cwd/bin/node when only the sidecar cwd has it', async () => {
    disableBundledAnchors();
    // Launcher grandparent has no bin/node; only the (sidecar) cwd does.
    const launcher = path.join(tmp, 'dev-source', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    const sidecar = path.join(tmp, 'sidecar');
    const bundled = path.join(sidecar, 'bin', 'node');
    await touch(bundled);
    vi.spyOn(process, 'cwd').mockReturnValue(sidecar);

    expect(await resolveShimNode(launcher)).toBe(bundled);
  });

  it('falls back to bare "node" only when no anchor resolves (dev/unbundled box)', async () => {
    disableBundledAnchors();
    const launcher = path.join(tmp, 'repo', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    await fs.mkdir(path.dirname(launcher), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'no-bundle-cwd'));

    expect(await resolveShimNode(launcher)).toBe('node');
  });
});

/**
 * WI-3334 residual: even with resolveShimNode's anchors, a shim WRITTEN by the
 * dev-source operator (no PAPERCUSP_SIDECAR_BIN, tsx execPath) still baked bare
 * `node` — and nothing created the ~/.local/bin/node the shim's PATH leans on.
 * ensureBundledNodeLinked closes that: the primary operator's install run links
 * the bundled node there so bare `node` resolves regardless of which operator
 * wrote the shim.
 */
describe('ensureBundledNodeLinked', () => {
  it('links ~/.local/bin/node → the bundled node when resolvable (primary operator run)', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'node');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');

    expect(await ensureBundledNodeLinked(home)).toBe(true);
    const dest = path.join(home, '.local', 'bin', 'node');
    expect(await fs.realpath(dest)).toBe(await fs.realpath(bundled));
  });

  it('is a no-op (false) when no bundled node is resolvable (dev-source operator context)', async () => {
    disableBundledAnchors(); // no SIDECAR_BIN, execPath not node
    const home = path.join(tmp, 'home');

    expect(await ensureBundledNodeLinked(home)).toBe(false);
    // nothing created
    await expect(fs.access(path.join(home, '.local', 'bin', 'node'))).rejects.toThrow();
  });

  it('does NOT clobber an existing working node (user-installed or already linked)', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'node');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');
    const existing = path.join(home, '.local', 'bin', 'node');
    await touch(existing); // a real node already present

    expect(await ensureBundledNodeLinked(home)).toBe(false);
    const st = await fs.lstat(existing);
    expect(st.isSymbolicLink()).toBe(false); // left the user's real file untouched
  });

  it('replaces a DANGLING link (stale from a prior app version) with a fresh one', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'node');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');
    const dest = path.join(home, '.local', 'bin', 'node');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.symlink(path.join(tmp, 'old-bundle', 'node'), dest); // dangling → old node gone

    expect(await ensureBundledNodeLinked(home)).toBe(true);
    expect(await fs.realpath(dest)).toBe(await fs.realpath(bundled));
  });
});

/**
 * WI-3626: `gh auth setup-git` bakes WHICHEVER path `buildGithubLoginSpec` resolved
 * verbatim into `~/.gitconfig`'s credential helper. Without a stable shim, that
 * resolution falls to an app-bundle-relative path which dangles the instant the app
 * is renamed/replaced (confirmed live: `Papercusp.app` → `Papercusp Server.app`).
 * ensureGhLinked keeps `~/.papercusp/bin/gh` pointed at the CURRENT bundle's gh —
 * refreshed every boot, unlike ensureAgentClisLinked's link-once-if-missing — so an
 * app rename between boots re-points the symlink instead of reproducing the bug.
 */
describe('ensureGhLinked', () => {
  it('links ~/.papercusp/bin/gh → the bundled gh when resolvable via PAPERCUSP_SIDECAR_BIN', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'gh');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');

    expect(await ensureGhLinked(home, binDir)).toBe(true);
    const dest = path.join(binDir, 'gh');
    expect(await fs.realpath(dest)).toBe(await fs.realpath(bundled));
  });

  it('is a no-op (false) when no bundled gh is resolvable this run', async () => {
    disableBundledAnchors();
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'no-bundle-cwd'));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');

    expect(await ensureGhLinked(home, binDir)).toBe(false);
    await expect(fs.access(path.join(binDir, 'gh'))).rejects.toThrow();
  });

  it('is idempotent (false, no write) once already pointed at the current bundle', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'gh');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');

    expect(await ensureGhLinked(home, binDir)).toBe(true); // first run creates it
    expect(await ensureGhLinked(home, binDir)).toBe(false); // second run: already correct
  });

  it('THE REGRESSION: re-points the symlink when the app bundle was renamed between boots', async () => {
    const oldBundled = path.join(tmp, 'Papercusp.app', 'Contents', 'Resources', 'sidecar', 'bin', 'gh');
    await touch(oldBundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(oldBundled));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    expect(await ensureGhLinked(home, binDir)).toBe(true); // first boot: old bundle

    // Simulate an app rename: the old bundle is gone, a new one exists at a
    // DIFFERENT path (Papercusp.app -> Papercusp Server.app).
    await fs.rm(path.dirname(path.dirname(path.dirname(path.dirname(oldBundled)))), { recursive: true, force: true });
    const newBundled = path.join(tmp, 'Papercusp Server.app', 'Contents', 'Resources', 'sidecar', 'bin', 'gh');
    await touch(newBundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(newBundled));

    expect(await ensureGhLinked(home, binDir)).toBe(true); // second boot: re-points
    const dest = path.join(binDir, 'gh');
    expect(await fs.realpath(dest)).toBe(await fs.realpath(newBundled));
  });

  it('does not clobber an existing link when this run cannot resolve a source (dev box)', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'gh');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    await ensureGhLinked(home, binDir); // establish a working link

    disableBundledAnchors();
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'no-bundle-cwd'));
    expect(await ensureGhLinked(home, binDir)).toBe(false); // no source this run — leave it alone
    const dest = path.join(binDir, 'gh');
    expect(await fs.realpath(dest)).toBe(await fs.realpath(bundled)); // still the old, still-valid link
  });
});
