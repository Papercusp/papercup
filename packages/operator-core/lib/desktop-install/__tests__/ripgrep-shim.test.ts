/**
 * The `rg` entry point and the PATH that makes it reachable — P-017 / D-001 of
 * orchestration-surface-residue-drain-2026-08-23.
 *
 * These two halves are tested together on purpose. Either alone is inert: a shim in
 * a directory no spawned child searches is unreachable, and a directory on the path
 * with no shim in it supplies nothing. The defect four agents filed on 2026-08-23
 * was the ABSENCE OF BOTH, so the fix is only verified when both hold.
 *
 * TEETH: the exec test runs the generated script against a FAKE claude that reports
 * its own argv[0]. That makes `exec -a rg` — the one mechanism the whole shim exists
 * for — an observed behaviour rather than a string match on the source we just
 * wrote, and it needs no real ripgrep or real claude on the host.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeRipgrepShim } from '../papercusp-files';
import { augmentedSpawnPath } from '../../plugin-spawn-impl';

const run = promisify(execFile);

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-rg-shim-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A stand-in for the claude binary: prints the argv[0] it was invoked under. That
 *  is the ONLY thing the real binary uses to decide it should behave as ripgrep. */
async function writeFakeClaude(dir: string): Promise<string> {
  const p = path.join(dir, 'fake-claude');
  await fs.writeFile(p, '#!/usr/bin/env bash\necho "argv0=$0"\necho "args=$*"\n', { mode: 0o755 });
  await fs.chmod(p, 0o755);
  return p;
}

describe('writeRipgrepShim — the generated entry point', () => {
  it('execs the resolved claude under argv[0]=rg and forwards the arguments', async () => {
    // The stand-in MUST be a real ELF, not a shebang script. Measured on this host:
    // `exec -a rg ./script.sh` reports $0 as the SCRIPT PATH, because the kernel
    // re-execs the interpreter with the script as an argument and the assigned
    // argv[0] is discarded; the same exec onto the node binary reports `rg`. A bash
    // stand-in would therefore fail this assertion while the shim was perfectly
    // correct — a blind instrument, not a defect. `process.execPath` is an ELF and
    // is guaranteed present wherever these tests run.
    const shim = path.join(tmp, 'rg');
    expect(await writeRipgrepShim(shim, { claudeExecutable: process.execPath })).toBe(true);

    const { stdout } = await run(shim, ['-e', 'console.log("argv0=" + process.argv0)'], {
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    });

    // The whole point: the child sees itself as `rg`, not as claude. A shim that
    // exec'd normally would report the claude path here and the real binary's
    // embedded ripgrep would never engage — indistinguishable from "it worked" if
    // you only assert exit 0.
    expect(stdout).toContain('argv0=rg');
  });

  it('forwards its arguments through unchanged', async () => {
    // Split from the argv[0] assertion because a shebang stand-in CAN observe "$@"
    // faithfully even though it cannot observe argv[0] — so this half is testable
    // with the simpler fake, and keeping them apart says which property broke.
    const claude = await writeFakeClaude(tmp);
    const shim = path.join(tmp, 'rg');
    await writeRipgrepShim(shim, { claudeExecutable: claude });

    const { stdout } = await run(shim, ['-n', '--glob', '*.ts', 'needle'], {
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    });
    expect(stdout).toContain('args=-n --glob *.ts needle');
  });

  it('prefers CLAUDE_CODE_EXECPATH over the baked-in path when the caller sets it', async () => {
    const baked = await writeFakeClaude(tmp);
    const overrideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-rg-override-'));
    try {
      const override = path.join(overrideDir, 'fake-claude');
      await fs.writeFile(override, '#!/usr/bin/env bash\necho "which=override"\n', { mode: 0o755 });
      await fs.chmod(override, 0o755);

      const shim = path.join(tmp, 'rg');
      await writeRipgrepShim(shim, { claudeExecutable: baked });
      const { stdout } = await run(shim, [], {
        env: { ...process.env, PATH: '/usr/bin:/bin', CLAUDE_CODE_EXECPATH: override },
      });
      expect(stdout).toContain('which=override');
    } finally {
      await fs.rm(overrideDir, { recursive: true, force: true });
    }
  });

  it('exits 127 naming the real cause when no claude binary can be found', async () => {
    const shim = path.join(tmp, 'rg');
    await writeRipgrepShim(shim, { claudeExecutable: path.join(tmp, 'does-not-exist') });

    await expect(run(shim, ['x'], { env: { ...process.env, PATH: '/usr/bin:/bin', CLAUDE_CODE_EXECPATH: '' } })).rejects.toMatchObject({
      code: 127,
    });

    // The message matters as much as the code. A bare "command not found" is what
    // sent four filings after a PATH that was never the problem, so the shim must
    // say ripgrep is absent AND name the fallbacks.
    const err = await run(shim, ['x'], { env: { ...process.env, PATH: '/usr/bin:/bin', CLAUDE_CODE_EXECPATH: '' } }).catch(
      (e: { stderr?: string }) => e,
    );
    expect(err.stderr).toContain('ripgrep is unavailable');
    expect(err.stderr).toContain('grep -rn');
    expect(err.stderr).toContain('gitnexus.context');
  });

  it('stands aside when a real ripgrep resolves elsewhere — and writes nothing', async () => {
    const shim = path.join(tmp, 'rg');
    expect(await writeRipgrepShim(shim, { resolvesElsewhere: true })).toBe(false);
    // Returning false is not enough: a shim written and then reported as skipped
    // would still shadow a real ripgrep through this directory.
    await expect(fs.access(shim)).rejects.toThrow();
  });

  it('CONTROL: the identical call WITHOUT resolvesElsewhere does write it', async () => {
    // Without this, the test above passes just as well if writeRipgrepShim were
    // broken and never wrote anything under any condition.
    const shim = path.join(tmp, 'rg');
    expect(await writeRipgrepShim(shim, { resolvesElsewhere: false })).toBe(true);
    await expect(fs.access(shim)).resolves.toBeUndefined();
  });

  it('is executable, and stays executable when an existing shim is overwritten', async () => {
    const shim = path.join(tmp, 'rg');
    await fs.writeFile(shim, 'stale\n', { mode: 0o644 });
    await writeRipgrepShim(shim, { claudeExecutable: await writeFakeClaude(tmp) });
    // writeFile honours `mode` only on CREATION, so the refresh-on-every-boot
    // contract silently produces a non-executable shim without the explicit chmod.
    const st = await fs.stat(shim);
    expect(st.mode & 0o111).not.toBe(0);
  });
});

describe('augmentedSpawnPath — ~/.papercusp/bin is reachable from a spawned child', () => {
  const home = process.env.HOME ?? os.homedir();

  it('includes the papercusp shim directory', () => {
    // Without this entry the shim above is written somewhere no capability:bash /
    // code:run / recipe child ever searches, because ensureBinOnPath only edits the
    // user's SHELL profile and a scrubbed `bash -c` child never reads one.
    expect(augmentedSpawnPath().split(path.delimiter)).toContain(path.join(home, '.papercusp/bin'));
  });

  it('appends it LAST so it can supply a missing command but never shadow a present one', () => {
    // ~/.papercusp/bin also holds copies of binaries that resolve elsewhere (omp,
    // claude, bun). Placing it anywhere earlier would silently change which of those
    // a spawn picks up — a much larger blast radius than the one missing command
    // this entry exists to supply.
    const dirs = augmentedSpawnPath().split(path.delimiter);
    expect(dirs.at(-1)).toBe(path.join(home, '.papercusp/bin'));
  });

  it('CONTROL: the entry is deduped, not appended twice, when it is already on PATH', () => {
    const withIt = { ...process.env, PATH: `${path.join(home, '.papercusp/bin')}${path.delimiter}/usr/bin` };
    const saved = process.env.PATH;
    try {
      process.env.PATH = withIt.PATH;
      const dirs = augmentedSpawnPath().split(path.delimiter);
      const hits = dirs.filter((d) => d === path.join(home, '.papercusp/bin'));
      expect(hits).toHaveLength(1);
    } finally {
      process.env.PATH = saved;
    }
  });
});
