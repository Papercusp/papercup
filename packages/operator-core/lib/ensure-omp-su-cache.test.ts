/**
 * Unit tests for ensureOmpSuInstalled (ensure-omp-su.ts) — its OWN logic.
 *
 * The sibling ensure-omp-su.test.ts only asserts the retired-wrapper
 * behavior. This file covers the parts the prompt calls out as untested:
 *   - the single-flight cache returns the SAME promise across concurrent
 *     calls, and HOLDS the cache even when the cached run rejects (a
 *     transient failure must NOT cause the next launch to re-spend ~5s)
 *   - the non-Linux guard early-returns (no bootstrap / no shellouts)
 *   - ensureOmpHindsightConfig's `omp config set` shellouts actually fire
 *     (5 keys), gated on `omp` being on PATH
 *
 * Hermetic: child_process (execSync/execFileSync) + fs + os + the two
 * desktop-install leaves are all mocked; nothing spawns or touches the
 * real home. `process.platform` is overridden per-test (it's read-only, so
 * via Object.defineProperty) and restored after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome = '';
const realPlatform = process.platform;
const realPath = process.env.PATH;

/** Override the read-only process.platform for one test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

const execFileSyncSpy = vi.fn();
const execSyncSpy = vi.fn();
const installPapercuspFilesSpy = vi.fn(async () => ({ playbookWritten: true, extensionWritten: true }));
const installOmpIntegrationSpy = vi.fn(async () => ({ changed: false, actions: [], reason: undefined }));
// Holder so a single os mock can be flipped to throw from homedir() per-test
// (the rejection-hold case) — no per-test re-mock, so nothing leaks.
const homeState = { throws: false };

beforeEach(() => {
  vi.resetModules();
  execFileSyncSpy.mockReset();
  execSyncSpy.mockReset();
  installPapercuspFilesSpy.mockClear();
  installOmpIntegrationSpy.mockClear();
  homeState.throws = false;
  tmpHome = mkdtempSync(join(tmpdir(), 'ensure-omp-su-cache-'));

  // The source resolves `omp` by scanning process.env.PATH with pure-Node
  // statSync (audit P-080 — no shell), so the child_process mock below can't
  // satisfy the on-PATH check. Plant a stub binary in a temp dir and prepend
  // it so the test is hermetic on boxes WITHOUT a real omp install (the CI
  // runner — WI-123); the actual shellouts still hit the execFileSync spy.
  mkdirSync(join(tmpHome, 'bin'), { recursive: true });
  writeFileSync(join(tmpHome, 'bin', 'omp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(tmpHome, 'bin', 'omp-su'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${join(tmpHome, 'bin')}:${realPath ?? ''}`;

  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return {
      ...actual,
      homedir: () => {
        if (homeState.throws) throw new Error('home blown up');
        return tmpHome;
      },
    };
  });
  // command -v omp / omp-su succeed (omp IS on PATH); execFileSync (the actual
  // `omp config set` shellout) is a spy we assert against.
  vi.doMock('node:child_process', () => ({
    execSync: (...args: unknown[]) => {
      execSyncSpy(...args);
      const cmd = args[0] as string;
      const opts = args[1] as { encoding?: string } | undefined;
      if (cmd.startsWith('command -v')) {
        const bin = cmd.split(' ').pop() ?? '';
        return opts?.encoding ? `${join(tmpHome, 'bin', bin)}\n` : Buffer.from(`${join(tmpHome, 'bin', bin)}\n`);
      }
      return opts?.encoding ? '' : Buffer.from('');
    },
    execFileSync: (...args: unknown[]) => execFileSyncSpy(...args),
  }));
  // Partial mock (see ensure-omp-su.test.ts): keep the real pure
  // resolveInstallPaths; stub only the fs-writing installer.
  vi.doMock('./desktop-install/papercusp-files', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./desktop-install/papercusp-files')>();
    return {
      ...actual,
      installPapercuspFiles: installPapercuspFilesSpy,
    };
  });
  vi.doMock('./desktop-install/omp-integration', () => ({
    installOmpIntegration: installOmpIntegrationSpy,
  }));
});

afterEach(() => {
  setPlatform(realPlatform);
  if (realPath === undefined) delete process.env.PATH;
  else process.env.PATH = realPath;
  vi.doUnmock('node:os');
  vi.doUnmock('node:child_process');
  vi.doUnmock('./desktop-install/papercusp-files');
  vi.doUnmock('./desktop-install/omp-integration');
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe('ensureOmpSuInstalled — single-flight cache', () => {
  it('single-flights concurrent + repeat calls — the heavy work runs exactly once', async () => {
    setPlatform('linux');
    const mod = await import('./ensure-omp-su');

    // Two concurrent callers + a third after settle. (ensureOmpSuInstalled is
    // an `async` function, so each call returns a fresh promise wrapping the
    // cached one — identity differs by design; the contract is that the heavy
    // work behind the cache runs ONCE, which we assert by side-effect.)
    const p1 = mod.ensureOmpSuInstalled();
    const p2 = mod.ensureOmpSuInstalled();
    await Promise.all([p1, p2]);

    // The heavy bootstrap (installPapercuspFiles) + the 5 omp-config shellouts
    // (hindsight only: memory.backend + 4 hindsight.*) ran exactly once despite two
    // concurrent callers — the single-flight guard, not two re-runs. (The eval-tool-tier
    // disable moved to psu-launcher's per-session config, WI-2382 scoping fix.)
    expect(installPapercuspFilesSpy).toHaveBeenCalledTimes(1);
    expect(execFileSyncSpy).toHaveBeenCalledTimes(5);

    // A THIRD call after settle still reuses the cache (no re-run).
    await mod.ensureOmpSuInstalled();
    expect(installPapercuspFilesSpy).toHaveBeenCalledTimes(1);
    expect(execFileSyncSpy).toHaveBeenCalledTimes(5);
  });

  it('HOLDS the cache on rejection — a failing run is not retried by the next call', async () => {
    setPlatform('linux');
    // Force the cached run to REJECT after the heavy bootstrap: homedir() (the
    // default arg of readEngineerOmpBootstrapState, called unguarded at the
    // tail of the IIFE) throws via the per-test holder flag.
    homeState.throws = true;
    const mod = await import('./ensure-omp-su');

    const p1 = mod.ensureOmpSuInstalled();
    // Swallow the floating cached rejection up-front so vitest's
    // unhandled-rejection guard doesn't flag it before assertions attach.
    p1.catch(() => {});
    await expect(p1).rejects.toThrow('home blown up');

    // The next call re-exposes the SAME held (rejected) cache — it does NOT
    // re-run the work. (Identity differs — async fn — so we assert by the
    // rejection + the unchanged side-effect count.)
    const p2 = mod.ensureOmpSuInstalled();
    p2.catch(() => {});
    await expect(p2).rejects.toThrow('home blown up');
    // The heavy bootstrap still ran exactly once (the held, failed run);
    // the second call did NOT re-invoke it.
    expect(installPapercuspFilesSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ensureOmpSuInstalled — platform guard', () => {
  it('non-Linux: early-returns without bootstrapping or shelling out', async () => {
    setPlatform('darwin');
    const mod = await import('./ensure-omp-su');

    await mod.ensureOmpSuInstalled();

    expect(installPapercuspFilesSpy).not.toHaveBeenCalled();
    expect(installOmpIntegrationSpy).not.toHaveBeenCalled();
    expect(execFileSyncSpy).not.toHaveBeenCalled();
  });
});

describe('ensureOmpSuInstalled — ensureOmpHindsightConfig shellouts', () => {
  it('fires the 5 `omp config set` shellouts (omp on PATH) with the hindsight keys only', async () => {
    setPlatform('linux');
    const mod = await import('./ensure-omp-su');

    await mod.ensureOmpSuInstalled();

    // 5 keys: memory.backend + 4 hindsight.* (ensureOmpHindsightConfig) — each a separate `omp
    // config set`. The eval-tool-tier disable is NO LONGER set here: it moved to psu-launcher's
    // per-session config (writeOmpSessionConfigDir string-surgery) so eval is off only for psu
    // agent sessions and the user's global ~/.omp keeps eval enabled (WI-2382 scoping fix).
    expect(execFileSyncSpy).toHaveBeenCalledTimes(5);
    const keysSet = execFileSyncSpy.mock.calls.map((c) => {
      const argv = c[1] as string[];
      return argv[2]; // omp config set <key> <value>
    });
    expect(keysSet).toEqual([
      'memory.backend',
      'hindsight.apiUrl',
      'hindsight.scoping',
      'hindsight.autoRecall',
      'hindsight.autoRetain',
    ]);
    // Each is an `omp config set …` invocation.
    for (const call of execFileSyncSpy.mock.calls) {
      expect(call[0]).toBe('omp');
      expect((call[1] as string[]).slice(0, 2)).toEqual(['config', 'set']);
    }
    // memory.backend → hindsight specifically.
    expect(execFileSyncSpy.mock.calls[0][1]).toEqual(['config', 'set', 'memory.backend', 'hindsight']);
    // NO eval.* shellout fires here anymore (moved to per-session psu-launcher config).
    for (const lang of ['eval.py', 'eval.js', 'eval.rb', 'eval.jl']) {
      expect(execFileSyncSpy.mock.calls.find((c) => (c[1] as string[])[2] === lang)).toBeUndefined();
    }
  });

  it('honors PAPERCUSP_HINDSIGHT_API_URL for the hindsight.apiUrl shellout', async () => {
    setPlatform('linux');
    process.env.PAPERCUSP_HINDSIGHT_API_URL = 'http://hindsight.test:9999';
    try {
      const mod = await import('./ensure-omp-su');
      await mod.ensureOmpSuInstalled();
      const apiUrlCall = execFileSyncSpy.mock.calls.find((c) => (c[1] as string[])[2] === 'hindsight.apiUrl');
      expect(apiUrlCall?.[1]).toEqual(['config', 'set', 'hindsight.apiUrl', 'http://hindsight.test:9999']);
    } finally {
      delete process.env.PAPERCUSP_HINDSIGHT_API_URL;
    }
  });
});
