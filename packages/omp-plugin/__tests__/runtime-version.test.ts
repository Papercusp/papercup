/** Installed startup metadata proof. No prompt or model request is submitted. */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { resolveOnPath, wellKnownBackendBin } from '../../operator-core/lib/backend-bin-resolve.mjs';
import { ompSessionHeaderIndex } from '../../operator-core/lib/transcript-wire';

describe('installed OMP startup version metadata', () => {
  it.each(['measured', 'header-only'] as const)('retains %s native provenance before the first prompt', async mode => {
    const omp = wellKnownBackendBin('omp') ?? resolveOnPath('omp');
    expect(omp, 'An installed OMP executable is required; absence is not a pass').toBeTruthy();
    const version = /^omp\/(\S+)$/.exec(execFileSync(omp!, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim())?.[1];
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    const root = mkdtempSync(join(tmpdir(), 'omp-runtime-version-'));
    try {
      const fakeBin = join(root, 'fake-bin'); mkdirSync(fakeBin);
      // A PATH probe would see this other install. The running hook must use
      // its own executable even when the configured PATH changes underneath it.
      writeFileSync(join(fakeBin, 'omp'), '#!/bin/sh\nprintf "omp/999.0.0\\n"\n', { mode: 0o700 });
      const extension = join(root, 'startup.ts'), resultFile = join(root, 'native.json');
      // Match install_omp_hook_bundle: native OMP loads the standalone bundle,
      // whose package imports are resolved at build time inside the workspace.
      const bundledHook = join(root, 'coord-hook.mjs');
      const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../../apps/operator/scripts/hooks/omp/coord-hook.ts', import.meta.url))],
        bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false, logLevel: 'silent' });
      expect(bundle.outputFiles).toHaveLength(1);
      writeFileSync(bundledHook, bundle.outputFiles![0]!.text);
      writeFileSync(extension, [
        `import { recordOmpRuntimeVersion, ensureNativeSessionOnDisk } from ${JSON.stringify(bundledHook)};`,
        "import { writeFileSync } from 'node:fs';",
        'export default function(pi) {',
        "  pi.registerProvider('runtime-proof', { api: 'runtime-proof-api', apiKey: 'unused', baseUrl: 'http://unused.invalid',",
        "    models: [{ id: 'proof', name: 'Startup only', reasoning: false, input: ['text'],",
        '      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],',
        "    streamSimple() { throw new Error('Startup proof must never request inference'); } });",
        "  pi.on('session_start', async (_, ctx) => {",
        `    const measured = ${mode === 'measured' ? 'await recordOmpRuntimeVersion(pi, ctx)' : 'false'};`,
        '    await ensureNativeSessionOnDisk(ctx);',
        `    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ measured, id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() }));`,
        '    process.exit(0);',
        '  });',
        '}',
      ].join('\n'));
      await promisify(execFile)(omp!, ['--mode', 'rpc', '--no-extensions', '--no-skills', '--no-rules',
        '--extension', extension, '--model', 'runtime-proof/proof'], {
        cwd: root, timeout: 30_000, maxBuffer: 64 * 1024,
        env: { PATH: [fakeBin, process.env.PATH ?? ''].join(delimiter), LANG: 'C.UTF-8',
          PI_CODING_AGENT_DIR: root, PI_CONFIG_DIR: root },
      });
      const proof = JSON.parse(readFileSync(resultFile, 'utf8'));
      expect(proof.measured).toBe(mode === 'measured');
      const lines = readFileSync(proof.file, 'utf8').trimEnd().split('\n');
      const records = lines.map(line => JSON.parse(line));
      const headerIndex = ompSessionHeaderIndex(lines);
      expect(headerIndex, JSON.stringify(records.slice(0, 2))).not.toBeNull();
      expect(records[headerIndex!]).toMatchObject({ type: 'session', id: proof.id });
      expect(typeof records[headerIndex!].version).toBe('number');
      expect(records.some(row => row.type === 'message')).toBe(false);
      const stamps = records.filter(row => row.type === 'custom' && row.customType === 'papercusp-omp-runtime');
      expect(stamps).toHaveLength(mode === 'measured' ? 1 : 0);
      if (mode === 'measured') expect(stamps[0].data).toEqual({ schemaVersion: 1, nativeSessionId: proof.id,
        clientVersion: version, measuredAt: expect.any(String) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 45_000);
});
