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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  CC_HOOK_FILES,
  installInjectionHooks,
  installOmpHookBundle,
  installPapercuspFiles,
} from './papercusp-files';
import { INSTALLED_FROM_BASENAME, readInstallStamp } from './install-provenance';

const run = promisify(execFile);

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

/**
 * Make the exact shared hook layout from a real git checkout. The installer
 * orders competing canonical checkouts by the commit date git reports, so a
 * mocked provenance value would not guard the source-resolution seam that
 * regressed live in EI-20333884491932817.
 */
async function makeGitHookSource(
  repo: string,
  marker: string,
  committedAt: string,
): Promise<{ injectDir: string; coordHook: string }> {
  const hooksDir = path.join(repo, 'scripts', 'hooks');
  const injectDir = path.join(hooksDir, 'inject');
  const ompDir = path.join(hooksDir, 'omp');
  await fs.mkdir(path.join(injectDir, 'adapters'), { recursive: true });
  await fs.mkdir(ompDir, { recursive: true });
  await fs.writeFile(path.join(injectDir, 'index.mjs'), `// dispatcher ${marker}\n`);
  await fs.writeFile(path.join(injectDir, 'adapters', 'omp.mjs'), `// adapter ${marker}\n`);
  await fs.writeFile(path.join(ompDir, 'inject-hook.ts'), `// inject hook ${marker}\n`);
  await fs.writeFile(path.join(ompDir, 'coord-hook.ts'), `// coord hook ${marker}\n`);

  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['config', 'user.name', 'Papercusp Test'], { cwd: repo });
  await run('git', ['config', 'user.email', 'test@papercusp.local'], { cwd: repo });
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-qm', marker], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: committedAt,
      GIT_COMMITTER_DATE: committedAt,
    },
  });
  return { injectDir, coordHook: path.join(ompDir, 'coord-hook.ts') };
}

async function makeGitCcHookSource(
  repo: string,
  marker: string,
  committedAt: string,
): Promise<{ ccDir: string }> {
  const ccDir = path.join(repo, 'scripts', 'hooks', 'cc');
  await fs.mkdir(ccDir, { recursive: true });
  for (const name of CC_HOOK_FILES) {
    await fs.writeFile(path.join(ccDir, name), `#!/bin/bash\n# ${marker}: ${name}\n`);
  }

  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['config', 'user.name', 'Papercusp Test'], { cwd: repo });
  await run('git', ['config', 'user.email', 'test@papercusp.local'], { cwd: repo });
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-qm', marker], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: committedAt,
      GIT_COMMITTER_DATE: committedAt,
    },
  });
  return { ccDir };
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

  it('refuses a minutes-old real-git source across the shared dispatcher, OMP hook, and root coordination bundle', async () => {
    const newerRepo = path.join(root, 'newer-checkout');
    const staleRepo = path.join(root, 'stale-release-checkout');
    await fs.mkdir(newerRepo, { recursive: true });
    await fs.mkdir(staleRepo, { recursive: true });
    const newer = await makeGitHookSource(newerRepo, 'newer', '2026-08-13T12:05:00Z');
    const stale = await makeGitHookSource(staleRepo, 'stale', '2026-08-13T12:00:00Z');

    await installInjectionHooks(home, newer.injectDir);
    const newerRootInstall = await installPapercuspFiles({
      home,
      operatorAppRoot: newerRepo,
      playbookSource: path.join(newerRepo, 'missing-playbook.md'),
      extensionSource: newer.coordHook,
    });
    expect(newerRootInstall.extensionWritten).toBe(true);

    const before = {
      dispatcher: await fs.readFile(path.join(injectDest(), 'index.mjs'), 'utf8'),
      ompHook: await fs.readFile(path.join(ompDest(), 'inject-hook.ts'), 'utf8'),
      coordHook: await fs.readFile(path.join(home, '.papercusp', 'papercusp-coord.ts'), 'utf8'),
      injectStamp: await fs.readFile(path.join(injectDest(), INSTALLED_FROM_BASENAME), 'utf8'),
      ompStamp: await fs.readFile(path.join(ompDest(), INSTALLED_FROM_BASENAME), 'utf8'),
    };

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await installInjectionHooks(home, stale.injectDir)).toEqual([]);
    const staleRootInstall = await installPapercuspFiles({
      home,
      operatorAppRoot: staleRepo,
      playbookSource: path.join(staleRepo, 'missing-playbook.md'),
      extensionSource: stale.coordHook,
    });

    expect(staleRootInstall.extensionWritten).toBe(false);
    expect(await fs.readFile(path.join(injectDest(), 'index.mjs'), 'utf8')).toBe(before.dispatcher);
    expect(await fs.readFile(path.join(ompDest(), 'inject-hook.ts'), 'utf8')).toBe(before.ompHook);
    expect(await fs.readFile(path.join(home, '.papercusp', 'papercusp-coord.ts'), 'utf8')).toBe(before.coordHook);
    expect(await fs.readFile(path.join(injectDest(), INSTALLED_FROM_BASENAME), 'utf8')).toBe(before.injectStamp);
    expect(await fs.readFile(path.join(ompDest(), INSTALLED_FROM_BASENAME), 'utf8')).toBe(before.ompStamp);
    expect(error.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/REFUSING downgrade/);
  });

  it('logs and stamps the CC source unit + path-specific sha on a successful install', async () => {
    const repo = path.join(root, 'cc-checkout');
    await fs.mkdir(repo, { recursive: true });
    const source = await makeGitCcHookSource(repo, 'cc-success', '2026-08-13T12:05:00Z');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await installPapercuspFiles({
      home,
      operatorAppRoot: repo,
      playbookSource: path.join(repo, 'missing-playbook.md'),
      extensionSource: path.join(repo, 'missing-extension.ts'),
    });

    expect(result.claudeHooksInstalled).toContain('pretooluse-locks-acquire.sh');
    const stamp = await readInstallStamp(path.join(home, '.papercusp', 'hooks', 'cc'));
    expect(stamp?.sourceDir).toBe(source.ccDir);
    expect(stamp?.sourceCommittedAt).toBe('2026-08-13T12:05:00.000Z');
    expect(stamp?.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(stamp?.unit).toMatch(/^hono-host:/);
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
      new RegExp(`hooks/cc <- ${source.ccDir.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')} \\(unit=[^,]+, sha=[0-9a-f]{40}\\)`),
    );
  });

  it('refuses a newer-installed CC hook bundle even when the stale source is only minutes older', async () => {
    const newerRepo = path.join(root, 'cc-newer-checkout');
    const staleRepo = path.join(root, 'cc-stale-checkout');
    await fs.mkdir(newerRepo, { recursive: true });
    await fs.mkdir(staleRepo, { recursive: true });
    const newer = await makeGitCcHookSource(newerRepo, 'cc-newer', '2026-08-13T12:05:00Z');
    const stale = await makeGitCcHookSource(staleRepo, 'cc-stale', '2026-08-13T12:00:00Z');

    await installPapercuspFiles({
      home,
      operatorAppRoot: newerRepo,
      playbookSource: path.join(newerRepo, 'missing-playbook.md'),
      extensionSource: path.join(newerRepo, 'missing-extension.ts'),
    });
    const installedPath = path.join(home, '.papercusp', 'hooks', 'cc', 'userpromptsubmit-provenance.sh');
    const before = await fs.readFile(installedPath, 'utf8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const staleResult = await installPapercuspFiles({
      home,
      operatorAppRoot: staleRepo,
      playbookSource: path.join(staleRepo, 'missing-playbook.md'),
      extensionSource: path.join(staleRepo, 'missing-extension.ts'),
    });

    expect(staleResult.claudeHooksInstalled).toEqual([]);
    expect(await fs.readFile(installedPath, 'utf8')).toBe(before);
    expect((await readInstallStamp(path.join(home, '.papercusp', 'hooks', 'cc')))?.sourceDir).toBe(newer.ccDir);
    expect(error.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
      /cc hooks: REFUSING downgrade.*300000ms older/,
    );
  });
});
