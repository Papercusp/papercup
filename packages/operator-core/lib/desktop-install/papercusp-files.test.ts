/**
 * papercusp-files.test.ts — resolveShimNode, the node-binary resolver the psu /
 * dispatcher CLI shims exec (writeShim + writeDispatcherShim).
 *
 * Regression guard for WI-3334: on a packaged dogfood install with NO system
 * node, the shim resolved the launcher to the EXTRACTED dev-source tree
 * (`<dev-source>/apps/operator/scripts/psu-launcher.mjs`), so the single-anchor
 * `dirname(dirname(launcher))/bin/node` pointed at `<dev-source>/apps/operator/bin/node`
 * (nonexistent) and the shim fell back to bare `node` → "node not found". The
 * fix adds a second anchor — the sidecar root (`process.cwd()/bin/node`), which
 * IS the real bundled node on a packaged install (serve.mjs runs cwd = sidecar).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveShimNode } from './papercusp-files';

let tmp: string;

/** Create an empty file (its parent dirs too) so fs.access / pathExists sees it. */
async function touch(p: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, '');
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-node-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveShimNode', () => {
  it('anchor 1: returns the bundled node next to the launcher (dirname(dirname(launcher))/bin/node)', async () => {
    // Bundled layout: sidecar/scripts/<launcher> → sidecar/bin/node.
    const sidecar = path.join(tmp, 'sidecar');
    const launcher = path.join(sidecar, 'scripts', 'psu-launcher.mjs');
    const bundledNode = path.join(sidecar, 'bin', 'node');
    await touch(bundledNode);
    // cwd points somewhere WITHOUT bin/node, so only anchor 1 can match.
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'elsewhere'));

    expect(await resolveShimNode(launcher)).toBe(bundledNode);
  });

  it('anchor 2 (WI-3334): falls through to the sidecar-root cwd/bin/node when the launcher grandparent has none', async () => {
    // The regression layout: launcher resolved to the extracted dev-source tree,
    // whose grandparent (<dev-source>/apps/operator) has NO bin/node.
    const devSource = path.join(tmp, 'dev-source');
    const launcher = path.join(devSource, 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    // The packaged serve.mjs runs with cwd = the sidecar root, which HAS the node.
    const sidecar = path.join(tmp, 'sidecar');
    const bundledNode = path.join(sidecar, 'bin', 'node');
    await touch(bundledNode);
    vi.spyOn(process, 'cwd').mockReturnValue(sidecar);

    // Anchor 1 (<dev-source>/apps/operator/bin/node) does NOT exist, so anchor 2 wins.
    expect(await resolveShimNode(launcher)).toBe(bundledNode);
  });

  it('prefers anchor 1 over anchor 2 when BOTH exist (bundled node next to the launcher wins)', async () => {
    const sidecar = path.join(tmp, 'sidecar');
    const launcher = path.join(sidecar, 'scripts', 'psu-launcher.mjs');
    const anchor1 = path.join(sidecar, 'bin', 'node');
    await touch(anchor1);
    // A DIFFERENT cwd that also has a bin/node — anchor 1 must still win.
    const otherCwd = path.join(tmp, 'other-cwd');
    await touch(path.join(otherCwd, 'bin', 'node'));
    vi.spyOn(process, 'cwd').mockReturnValue(otherCwd);

    expect(await resolveShimNode(launcher)).toBe(anchor1);
  });

  it('falls back to bare "node" only when neither anchor has a bundled node (dev/unbundled box)', async () => {
    const launcher = path.join(tmp, 'repo', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    await fs.mkdir(path.dirname(launcher), { recursive: true });
    // Neither the launcher grandparent nor cwd has bin/node.
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'no-bundle-cwd'));

    expect(await resolveShimNode(launcher)).toBe('node');
  });
});
