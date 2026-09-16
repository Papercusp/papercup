// @vitest-environment node
/**
 * WI-10001537: `healShadowedManagedShims` — repoint an unmanaged wrapper that
 * shadows a managed `~/.papercusp/bin` shim.
 *
 * The incident these guard: `~/.local/bin/psu`, a 347-byte one-liner left by the
 * retired install-standalone-mcp.sh, sat EARLIER on PATH than the managed shim
 * that gets rewritten on every boot. It advertised no `PAPERCUSP_PSU_REEXEC`, so
 * psu-launcher wired `onReexec: null` by design, the host lost its clean
 * hand-off to a fresh process, and a live interactive session died mid-dialog.
 * Every layer was individually correct; only their ORDER on PATH was wrong, and
 * nothing anywhere looked at that.
 *
 * The three rails below are the ones worth owning a test each, because each
 * protects against a way this self-healing rewrite could be WORSE than the bug:
 * a symlink cycle that makes `claude` unlaunchable, hijacking a user's unrelated
 * binary, and destroying a file we displaced.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  healShadowedManagedShims,
  SHADOWED_SHIM_BACKUP_SUFFIX,
} from './papercusp-files.js';

let home: string;
let binDir: string;
let localBin: string;

/** A stale wrapper of the shape the retired installer actually wrote. */
const STALE_PSU = '#!/usr/bin/env bash\n# papercusp tracked SU launcher (managed by install-standalone-mcp.sh).\nexec node "/repo/apps/operator/scripts/psu-launcher.mjs" "$@"\n';

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-shadow-'));
  binDir = path.join(home, '.papercusp', 'bin');
  localBin = path.join(home, '.local', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(localBin, { recursive: true });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function writeManagedShim(name: string, body = '#!/usr/bin/env bash\n# managed by Papercusp.app\n') {
  const p = path.join(binDir, name);
  await fs.writeFile(p, body, { mode: 0o755 });
  return p;
}

describe('healShadowedManagedShims', () => {
  it('repoints a stale papercusp wrapper at the managed shim and preserves the original', async () => {
    const managed = await writeManagedShim('psu');
    const shadow = path.join(localBin, 'psu');
    await fs.writeFile(shadow, STALE_PSU, { mode: 0o755 });

    const healed = await healShadowedManagedShims(home, binDir, [localBin, binDir]);

    expect(healed).toEqual([
      { name: 'psu', shadowPath: shadow, managedPath: managed, action: 'repointed' },
    ]);
    // The shadow now RESOLVES to the managed shim, so both spellings of `psu`
    // run one implementation — which is the entire point.
    expect(await fs.realpath(shadow)).toBe(await fs.realpath(managed));
    // Nothing was destroyed.
    expect(await fs.readFile(`${shadow}${SHADOWED_SHIM_BACKUP_SUFFIX}`, 'utf8')).toBe(STALE_PSU);
  });

  it('is idempotent, and a second pass does not overwrite the original backup', async () => {
    await writeManagedShim('psu');
    const shadow = path.join(localBin, 'psu');
    await fs.writeFile(shadow, STALE_PSU, { mode: 0o755 });

    await healShadowedManagedShims(home, binDir, [localBin, binDir]);
    const second = await healShadowedManagedShims(home, binDir, [localBin, binDir]);

    // Already correct => reported as nothing to do, not re-healed every boot.
    expect(second).toEqual([]);
    // The backup still holds the ORIGINAL wrapper, not a copy of our symlink.
    expect(await fs.readFile(`${shadow}${SHADOWED_SHIM_BACKUP_SUFFIX}`, 'utf8')).toBe(STALE_PSU);
  });

  it('NEVER touches a managed entry that is itself a symlink — this is the cycle rail', async () => {
    // ~/.papercusp/bin/claude is a symlink INTO ~/.local/bin/claude, put there by
    // ensureAgentClisLinked. Repointing ~/.local/bin/claude at it would make each
    // link point at the other and `claude` would stop launching entirely — a far
    // worse outcome than the bug being fixed.
    const realClaude = path.join(localBin, 'claude');
    await fs.writeFile(realClaude, '#!/bin/sh\n# papercusp mentions itself here\n', { mode: 0o755 });
    await fs.symlink(realClaude, path.join(binDir, 'claude'));

    const healed = await healShadowedManagedShims(home, binDir, [localBin, binDir]);

    expect(healed).toEqual([]);
    const st = await fs.lstat(realClaude);
    expect(st.isSymbolicLink()).toBe(false);
    // Still resolvable — i.e. no cycle was created.
    await expect(fs.realpath(path.join(binDir, 'claude'))).resolves.toBe(await fs.realpath(realClaude));
  });

  it('leaves a foreign binary that merely shares a name strictly alone', async () => {
    await writeManagedShim('psu');
    const shadow = path.join(localBin, 'psu');
    const foreign = '#!/bin/sh\n# somebody else\'s tool entirely\necho hi\n';
    await fs.writeFile(shadow, foreign, { mode: 0o755 });

    const healed = await healShadowedManagedShims(home, binDir, [localBin, binDir]);

    expect(healed).toEqual([
      { name: 'psu', shadowPath: shadow, managedPath: path.join(binDir, 'psu'), action: 'kept-foreign' },
    ]);
    expect(await fs.readFile(shadow, 'utf8')).toBe(foreign);
    // It is REPORTED rather than silently ignored, so a real collision is visible.
    expect(healed[0].action).toBe('kept-foreign');
  });

  it('never reaches into the managed bin dir itself', async () => {
    await writeManagedShim('psu');
    // binDir is in the shared search list; without the self-exclusion the shim
    // would be compared against, and relinked to, itself.
    const healed = await healShadowedManagedShims(home, binDir, [binDir]);
    expect(healed).toEqual([]);
    expect((await fs.lstat(path.join(binDir, 'psu'))).isSymbolicLink()).toBe(false);
  });

  it('is a no-op when the managed bin dir does not exist', async () => {
    await expect(
      healShadowedManagedShims(home, path.join(home, 'nope'), [localBin]),
    ).resolves.toEqual([]);
  });
});
