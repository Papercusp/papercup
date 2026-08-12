import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let tmpHome = '';
let fakeOmp = '';
let realPath = '';

beforeEach(() => {
  vi.resetModules();
  tmpHome = mkdtempSync(join(tmpdir(), 'ensure-omp-su-'));
  fakeOmp = join(tmpHome, 'bin', 'omp');
  mkdirSync(dirname(fakeOmp), { recursive: true });
  // P-080: binaries resolve via a pure-Node PATH scan now (no shell).
  // Pin PATH to ONLY the fake bin dir so the test never sees the host's
  // real omp / leftover omp-su.
  writeFileSync(fakeOmp, '#!/usr/bin/env bash\n');
  realPath = process.env.PATH ?? '';
  process.env.PATH = dirname(fakeOmp);

  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: () => tmpHome };
  });

  vi.doMock('node:child_process', async () => ({
    execFile: (...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void;
      queueMicrotask(() => callback(null));
    },
  }));

  // Partial mock: stub only the fs-writing installer; keep the REAL pure
  // resolveInstallPaths so claude-integration.ts (which imports it at module
  // load) doesn't fail-soft-skip its whole branch on a missing-export throw.
  vi.doMock('./desktop-install/papercusp-files', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./desktop-install/papercusp-files')>();
    return {
      ...actual,
      installPapercuspFiles: vi.fn(async () => ({ playbookWritten: true, extensionWritten: true })),
    };
  });

  vi.doMock('./desktop-install/omp-integration', () => ({
    installOmpIntegration: vi.fn(async () => ({ changed: false, actions: [] })),
  }));
});

afterEach(() => {
  process.env.PATH = realPath;
  vi.doUnmock('node:os');
  vi.doUnmock('node:child_process');
  vi.doUnmock('./desktop-install/papercusp-files');
  vi.doUnmock('./desktop-install/omp-integration');
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('ensure-omp-su', () => {
  it('reports bootstrap state + does NOT write/refresh the omp-su wrapper (P-050 retired)', async () => {
    const playbook = join(tmpHome, '.papercusp', 'engineer-collaborator.md');
    const coord = join(tmpHome, '.papercusp', 'papercusp-coord.ts');
    const wrapper = join(dirname(fakeOmp), 'omp-su');
    mkdirSync(dirname(playbook), { recursive: true });
    writeFileSync(playbook, '# playbook\n');
    writeFileSync(coord, '// coord\n');
    writeFileSync(wrapper, '#!/usr/bin/env bash\necho stale\n');

    const mod = await import('./ensure-omp-su');
    const before = mod.readEngineerOmpBootstrapState(tmpHome);
    expect(before.playbookPresent).toBe(true);
    expect(before.coordPresent).toBe(true);
    // A leftover (stale) wrapper is detectable for cleanup, but no longer managed.
    expect(before.wrapperPresent).toBe(true);

    await mod.ensureOmpSuInstalled();

    // The wrapper is retired — ensure must NOT (re)write or refresh it.
    expect(readFileSync(wrapper, 'utf8')).toBe('#!/usr/bin/env bash\necho stale\n');
  });

  it('installs the coord hook companion module when the phase-1 writer leaves bootstrap files absent', async () => {
    const repoRoot = join(tmpHome, 'source');
    const operatorApp = join(repoRoot, 'apps', 'operator');
    const ompDir = join(operatorApp, 'scripts', 'hooks', 'omp');
    mkdirSync(ompDir, { recursive: true });
    writeFileSync(join(operatorApp, 'scripts', 'install-standalone-mcp.sh'), '#!/usr/bin/env bash\n');
    writeFileSync(
      join(ompDir, 'coord-hook.ts'),
      "import { stashAdvisory } from './non-preempting-delivery';\nexport { stashAdvisory };\n",
    );
    writeFileSync(join(ompDir, 'non-preempting-delivery.ts'), 'export const stashAdvisory = () => {};\n');

    const previousRepoRoot = process.env.PAPERCUSP_REPO_ROOT;
    process.env.PAPERCUSP_REPO_ROOT = repoRoot;
    try {
      const mod = await import('./ensure-omp-su');
      await mod.ensureOmpSuInstalled();

      const installedRoot = join(tmpHome, '.papercusp');
      expect(readFileSync(join(installedRoot, 'papercusp-coord.ts'), 'utf8')).toContain(
        'non-preempting-delivery',
      );
      expect(readFileSync(join(installedRoot, 'non-preempting-delivery.ts'), 'utf8')).toContain(
        'stashAdvisory',
      );
    } finally {
      if (previousRepoRoot === undefined) delete process.env.PAPERCUSP_REPO_ROOT;
      else process.env.PAPERCUSP_REPO_ROOT = previousRepoRoot;
    }
  });

  it('falls back to ~/.local/bin for the wrapper dir when omp is not on PATH (P-080 non-shell scan)', async () => {
    rmSync(fakeOmp); // no omp anywhere on the pinned PATH
    const mod = await import('./ensure-omp-su');
    const state = mod.readEngineerOmpBootstrapState(tmpHome);
    expect(state.wrapperPath).toBe(join(tmpHome, '.local', 'bin', 'omp-su'));
  });
});

/**
 * WI-7344 — resolveSourceDir must prefer the canonical repo root over cwd.
 *
 * The operator process's cwd is the RELEASE checkout, so a cwd-first walk
 * installs the CC hooks and the rendered su persona from release. Measured
 * 2026-08-03: the live ask-gate-mirror.sh was byte-identical to a release copy
 * dated 2026-07-26 (8 days stale) and was RE-installed from release hours after
 * the fix landed in staging — so an agent's own hook fix could never reach the
 * agents. These pin the precedence and the packaged-app fallback.
 */
describe('resolveSourceDir precedence (WI-7344)', () => {
  let root = '';
  let cwdRoot = '';
  let realRepoRoot: string | undefined;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  const makeOperatorTree = (base: string) => {
    const appDir = join(base, 'apps', 'operator');
    mkdirSync(join(appDir, 'scripts'), { recursive: true });
    writeFileSync(join(appDir, 'scripts', 'install-standalone-mcp.sh'), '#!/usr/bin/env bash\n');
    return appDir;
  };

  beforeEach(() => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'wi7344-staging-'));
    cwdRoot = mkdtempSync(join(tmpdir(), 'wi7344-release-'));
    realRepoRoot = process.env.PAPERCUSP_REPO_ROOT;
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    if (realRepoRoot === undefined) delete process.env.PAPERCUSP_REPO_ROOT;
    else process.env.PAPERCUSP_REPO_ROOT = realRepoRoot;
    rmSync(root, { recursive: true, force: true });
    rmSync(cwdRoot, { recursive: true, force: true });
  });

  it('prefers PAPERCUSP_REPO_ROOT over the cwd walk — the release-staleness fix', async () => {
    const stagingApp = makeOperatorTree(root);
    const releaseApp = makeOperatorTree(cwdRoot);
    // cwd points at the RELEASE tree, exactly as the live operator's does.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(releaseApp);
    process.env.PAPERCUSP_REPO_ROOT = root;

    const mod = await import('./ensure-omp-su');
    expect(mod.resolveSourceDir()).toBe(stagingApp);
  });

  it('falls back to the cwd walk when PAPERCUSP_REPO_ROOT is unset (packaged app)', async () => {
    const releaseApp = makeOperatorTree(cwdRoot);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(releaseApp);
    delete process.env.PAPERCUSP_REPO_ROOT;

    const mod = await import('./ensure-omp-su');
    expect(mod.resolveSourceDir()).toBe(releaseApp);
  });

  it('ignores a PAPERCUSP_REPO_ROOT with no operator tree rather than returning a bad dir', async () => {
    // A stale/incorrect env var must FALL THROUGH to cwd, never point the
    // installer at a directory that has no scripts/ in it.
    const releaseApp = makeOperatorTree(cwdRoot);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(releaseApp);
    process.env.PAPERCUSP_REPO_ROOT = join(root, 'does', 'not', 'exist');

    const mod = await import('./ensure-omp-su');
    expect(mod.resolveSourceDir()).toBe(releaseApp);
  });
});
