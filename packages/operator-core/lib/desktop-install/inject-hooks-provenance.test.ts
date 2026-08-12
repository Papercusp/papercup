/**
 * installInjectionHooks — install-time provenance + the all-or-nothing property.
 *
 * ── WHY THIS FILE EXISTS (EI-20006285243973245) ──
 * Until now this installer had NO coverage at all and recorded NOTHING when it
 * ran. The CC hooks beside it have carried a `.installed-from` stamp since
 * WI-37405; the injection pair had none, so "when were these installed, and
 * from which build?" had no answer anywhere. That is what left a real omp
 * injection outage (2026-08-09 18:15Z) permanently cause-UNDETERMINED: the one
 * hypothesis left standing — that the dispatcher was absent or mid-install —
 * was untestable after the fact, because file mtimes are rewritten by this
 * function on EVERY psu launch and nothing else recorded a thing.
 *
 * ⚠ The negative cases below assert "no stamp was written", which is also what a
 * writeInstallStamp call that was deleted would produce. The CALIBRATION test
 * asserts a stamp IS written; if it fails, treat the negatives as vacuous.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { installInjectionHooks, installOmpHookBundle } from './papercusp-files';
import { INSTALLED_FROM_BASENAME, readInstallStamp } from './install-provenance';

let root: string;
let home: string;
let srcRoot: string;
let injectSrc: string;

/** Build the source layout the installer expects: `<srcRoot>/inject/**` beside
 *  `<srcRoot>/omp/inject-hook.ts`. */
async function makeSources(opts: { dispatcher?: boolean; ompArtifact?: boolean } = {}) {
  const { dispatcher = true, ompArtifact = true } = opts;
  await fs.mkdir(path.join(injectSrc, 'adapters'), { recursive: true });
  if (dispatcher) {
    await fs.writeFile(path.join(injectSrc, 'index.mjs'), '// dispatcher\n');
    await fs.writeFile(path.join(injectSrc, 'adapters', 'omp.mjs'), '// adapter\n');
  }
  if (ompArtifact) {
    await fs.mkdir(path.join(srcRoot, 'omp'), { recursive: true });
    await fs.writeFile(path.join(srcRoot, 'omp', 'inject-hook.ts'), '// artifact\n');
  }
}

const injectDest = () => path.join(home, '.papercusp', 'hooks', 'inject');
const ompDest = () => path.join(home, '.papercusp', 'hooks', 'omp');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'inject-hooks-prov-'));
  home = path.join(root, 'home');
  srcRoot = path.join(root, 'src', 'hooks');
  injectSrc = path.join(srcRoot, 'inject');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('installInjectionHooks — install provenance', () => {
  it('CALIBRATION (must pass or every negative below is vacuous): a good install stamps BOTH dest dirs', async () => {
    await makeSources();
    const installed = await installInjectionHooks(home, injectSrc);

    expect(installed).toContain(path.join('inject', 'index.mjs'));
    expect(installed).toContain(path.join('omp', 'inject-hook.ts'));
    expect(await readInstallStamp(injectDest())).not.toBeNull();
    expect(await readInstallStamp(ompDest())).not.toBeNull();
  });

  it('the dispatcher stamp DATES the install and names the source + files', async () => {
    // Dating the install is the whole point: mtimes cannot do it because this
    // function rewrites them on every psu launch.
    await makeSources();
    const before = Date.now();
    await installInjectionHooks(home, injectSrc);
    const stamp = await readInstallStamp(injectDest());

    expect(stamp!.sourceDir).toBe(injectSrc);
    expect(stamp!.files).toEqual(expect.arrayContaining(['index.mjs', path.join('adapters', 'omp.mjs')]));
    expect(stamp!.pid).toBe(process.pid);
    expect(Date.parse(stamp!.installedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('the omp artifact gets its OWN stamp, pointing at the omp source dir', async () => {
    // Separate dirs, separate stamps — the artifact is installed best-effort in
    // its own try, so it can legitimately be present/absent independently.
    await makeSources();
    await installInjectionHooks(home, injectSrc);
    const stamp = await readInstallStamp(ompDest());

    expect(stamp!.sourceDir).toBe(path.join(srcRoot, 'omp'));
    expect(stamp!.files).toEqual(['inject-hook.ts']);
  });

  it('installs relative OMP companions beside the injection importer and clears the load check', async () => {
    await makeSources();
    const ompSource = path.join(srcRoot, 'omp');
    await fs.writeFile(
      path.join(ompSource, 'inject-hook.ts'),
      "import { stashAdvisory } from './non-preempting-delivery';\nexport { stashAdvisory };\n",
    );
    await fs.writeFile(path.join(ompSource, 'non-preempting-delivery.ts'), 'export const stashAdvisory = () => {};\n');

    const installed = await installInjectionHooks(home, injectSrc);

    expect(installed).toContain(path.join('omp', 'inject-hook.ts'));
    expect(installed).toContain(path.join('omp', 'non-preempting-delivery.ts'));
    expect(await fs.readFile(path.join(ompDest(), 'non-preempting-delivery.ts'), 'utf8')).toContain('stashAdvisory');
    expect((await readInstallStamp(ompDest()))!.files).toEqual(
      expect.arrayContaining(['inject-hook.ts', 'non-preempting-delivery.ts']),
    );
  });

  it('reports an unresolved relative OMP import through the installer-side detector', async () => {
    const ompSource = path.join(srcRoot, 'omp');
    const destination = path.join(home, 'omp-dest');
    await fs.mkdir(ompSource, { recursive: true });
    await fs.writeFile(
      path.join(ompSource, 'coord-hook.ts'),
      "import './missing-companion';\nexport default {};\n",
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await installOmpHookBundle({
      sourceDir: ompSource,
      entryFile: 'coord-hook.ts',
      destinationDir: destination,
      destinationEntry: 'papercusp-coord.ts',
    });

    expect(result.installed).toEqual(['papercusp-coord.ts']);
    expect(result.unresolved).toEqual(['papercusp-coord.ts -> ./missing-companion']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('OMP hook bundle load check FAILED'));
  });

  it('logs one greppable line naming hooks/inject and inject-hook', async () => {
    // The exact probe the failed investigation ran was
    //   journalctl -u papercup-dev-api.service | grep -icE 'injectionHooks|hooks/inject|inject-hook'
    // which returned 0 for the whole window. Keep those substrings present.
    await makeSources();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await installInjectionHooks(home, injectSrc);

    const line = log.mock.calls.map(c => String(c[0])).join('\n');
    expect(line).toMatch(/hooks\/inject/);
    expect(line).toMatch(/inject-hook/);
  });

  it('ALL-OR-NOTHING: a missing dispatcher source installs nothing and stamps nothing', async () => {
    // A half-install (omp hook present, dispatcher absent) is the invisible
    // failure this installer exists to prevent — it yields a session that loads
    // the hook, finds nothing, and fail-silently injects nothing on every turn.
    await makeSources({ dispatcher: false });
    // Silenced because this path now (correctly) warns — asserted in the next case.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const installed = await installInjectionHooks(home, injectSrc);

    expect(installed).toEqual([]);
    expect(await readInstallStamp(injectDest())).toBeNull();
    expect(await readInstallStamp(ompDest())).toBeNull();
  });

  it('ALL-OR-NOTHING: the inactive case WARNS instead of being left to inference', async () => {
    // `[]` is documented as "omp injection inactive on this box", which every
    // downstream turn then presents as the indistinguishable "no memories were
    // relevant". Say it once, loudly.
    await makeSources({ dispatcher: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await installInjectionHooks(home, injectSrc);

    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/INACTIVE/);
  });

  it('a missing omp artifact still installs + stamps the dispatcher (claude/codex are unaffected)', async () => {
    // Regression guard: gating the dispatcher on the omp file would silently
    // disable injection for CLAUDE — ~100% of real traffic — over an unrelated
    // omp artifact.
    await makeSources({ ompArtifact: false });
    const installed = await installInjectionHooks(home, injectSrc);

    expect(installed).toContain(path.join('inject', 'index.mjs'));
    expect(installed).not.toContain(path.join('omp', 'inject-hook.ts'));
    expect(await readInstallStamp(injectDest())).not.toBeNull();
    expect(await readInstallStamp(ompDest())).toBeNull();
  });

  it('the stamp does not become a file the dispatcher copy loop picks up', async () => {
    // `.installed-from` lands in the DEST dir; the copy loops read the SOURCE.
    // A re-install must not start propagating it.
    await makeSources();
    await installInjectionHooks(home, injectSrc);
    const second = await installInjectionHooks(home, injectSrc);

    expect(second).not.toContain(path.join('inject', INSTALLED_FROM_BASENAME));
    expect(second.filter(f => f.includes(INSTALLED_FROM_BASENAME))).toEqual([]);
  });
});
