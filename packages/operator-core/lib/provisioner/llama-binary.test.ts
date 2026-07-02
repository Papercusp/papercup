import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DetectedHardware } from './hardware-detect';
import {
  platformKeyFor,
  derivePlatformSpec,
  detectCudaVersion,
  assetNameRules,
  pickPrebuiltAsset,
  pickLatestRelease,
  cudaBuildCommands,
  computeCapToArch,
  resolveLlamaBinary,
  type GhRelease,
  type ExecFn,
  type PlatformSpec,
} from './llama-binary';

// ---------------------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------------------

describe('platformKeyFor', () => {
  it('keys an NVIDIA CUDA spec by cuda + version', () => {
    expect(platformKeyFor({ os: 'linux', arch: 'x64', gpuVendor: 'nvidia', cudaVersion: '12.0' })).toBe('linux-x64-cuda-120');
  });
  it('keys an NVIDIA spec with no known cuda version', () => {
    expect(platformKeyFor({ os: 'linux', arch: 'x64', gpuVendor: 'nvidia' })).toBe('linux-x64-cuda');
  });
  it('keys AMD as hip, Apple as metal, none as cpu', () => {
    expect(platformKeyFor({ os: 'linux', arch: 'x64', gpuVendor: 'amd' })).toBe('linux-x64-hip');
    expect(platformKeyFor({ os: 'darwin', arch: 'arm64', gpuVendor: 'apple' })).toBe('darwin-arm64-metal');
    expect(platformKeyFor({ os: 'linux', arch: 'x64', gpuVendor: 'none' })).toBe('linux-x64-cpu');
  });
});

describe('derivePlatformSpec', () => {
  const base: DetectedHardware = { platform: 'linux', arch: 'x64', ramGB: 64, gpu: null, notes: [] };

  it('maps this box\'s real shape: linux/x64 + nvidia + a probed cuda version', () => {
    const hw: DetectedHardware = { ...base, gpu: { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', vramGB: 24, computeCap: '8.6' } };
    expect(derivePlatformSpec(hw, '12.0')).toEqual({ os: 'linux', arch: 'x64', gpuVendor: 'nvidia', cudaVersion: '12.0' });
  });

  it('never attaches a cudaVersion to a non-nvidia spec even if one is passed in', () => {
    const hw: DetectedHardware = { ...base, gpu: { vendor: 'amd', model: 'Radeon RX 7900 XTX', vramGB: 24 } };
    expect(derivePlatformSpec(hw, '12.0').cudaVersion).toBeUndefined();
  });

  it('maps win32/arm64 and darwin correctly; gpu:null -> none', () => {
    expect(derivePlatformSpec({ ...base, platform: 'win32', arch: 'arm64' })).toEqual({ os: 'win32', arch: 'arm64', gpuVendor: 'none', cudaVersion: undefined });
    expect(derivePlatformSpec({ ...base, platform: 'darwin', arch: 'arm64', gpu: { vendor: 'apple', vramGB: 36, unifiedMemory: true } })).toEqual({
      os: 'darwin',
      arch: 'arm64',
      gpuVendor: 'apple',
      cudaVersion: undefined,
    });
  });
});

describe('detectCudaVersion', () => {
  const execFrom = (out: string): ExecFn => async () => ({ stdout: out, stderr: '' });

  it('parses the real nvcc --version output shape from this box', async () => {
    const nvccOutput = `nvcc: NVIDIA (R) Cuda compiler driver
Copyright (c) 2005-2023 NVIDIA Corporation
Built on Fri_Jan__6_16:45:21_PST_2023
Cuda compilation tools, release 12.0, V12.0.140
Build cuda_12.0.r12.0/compiler.32267302_0
`;
    expect(await detectCudaVersion(execFrom(nvccOutput))).toBe('12.0');
  });

  it('returns undefined (never throws) when nvcc is absent', async () => {
    const exec: ExecFn = async () => {
      throw new Error('command not found: nvcc');
    };
    expect(await detectCudaVersion(exec)).toBeUndefined();
  });

  it('returns undefined on unparseable output', async () => {
    expect(await detectCudaVersion(execFrom('not nvcc output at all'))).toBeUndefined();
  });
});

describe('computeCapToArch', () => {
  it("strips the dot from this box's RTX 3090 compute capability", () => {
    expect(computeCapToArch('8.6')).toBe('86');
  });
  it('handles multi-digit minor versions', () => {
    expect(computeCapToArch('9.0')).toBe('90');
  });
});

describe('assetNameRules + pickPrebuiltAsset', () => {
  function asset(name: string) {
    return { name, browser_download_url: `https://example.com/${name}` };
  }
  function release(assets: string[]): GhRelease {
    return { tag_name: 'b5555', assets: assets.map(asset) };
  }

  it('macOS arm64: matches the metal-enabled universal asset regardless of GPU vendor field', () => {
    const spec: PlatformSpec = { os: 'darwin', arch: 'arm64', gpuVendor: 'apple' };
    expect(assetNameRules(spec)).toEqual([['macos', 'arm64']]);
    const r = release(['llama-b5555-bin-macos-x64.zip', 'llama-b5555-bin-macos-arm64.zip', 'llama-b5555-bin-ubuntu-x64.zip']);
    expect(pickPrebuiltAsset(r, spec)?.name).toBe('llama-b5555-bin-macos-arm64.zip');
  });

  it('Linux + no GPU (cpu-only): matches the ubuntu-x64 CPU asset', () => {
    const spec: PlatformSpec = { os: 'linux', arch: 'x64', gpuVendor: 'none' };
    const r = release(['llama-b5555-bin-macos-arm64.zip', 'llama-b5555-bin-ubuntu-x64.zip']);
    expect(pickPrebuiltAsset(r, spec)?.name).toBe('llama-b5555-bin-ubuntu-x64.zip');
  });

  it('Linux + NVIDIA: NO prebuilt asset exists (llama.cpp does not publish an accelerated Linux release) — always falls to build', () => {
    const spec: PlatformSpec = { os: 'linux', arch: 'x64', gpuVendor: 'nvidia', cudaVersion: '12.0' };
    expect(assetNameRules(spec)).toEqual([]);
    const r = release(['llama-b5555-bin-ubuntu-x64.zip', 'llama-b5555-bin-macos-arm64.zip', 'llama-b5555-bin-win-cuda-cu12.0-x64.zip']);
    expect(pickPrebuiltAsset(r, spec)).toBeNull();
  });

  it('Linux + AMD: also no prebuilt asset (same reasoning as NVIDIA)', () => {
    const spec: PlatformSpec = { os: 'linux', arch: 'x64', gpuVendor: 'amd' };
    expect(pickPrebuiltAsset(release(['llama-b5555-bin-ubuntu-x64.zip']), spec)).toBeNull();
  });

  it('Windows + NVIDIA: prefers an exact cuda-version match over a generic cuda asset', () => {
    const spec: PlatformSpec = { os: 'win32', arch: 'x64', gpuVendor: 'nvidia', cudaVersion: '12.4' };
    const r = release(['llama-b5555-bin-win-cuda-cu11.7-x64.zip', 'llama-b5555-bin-win-cuda-cu12.4-x64.zip', 'llama-b5555-bin-win-avx2-x64.zip']);
    expect(pickPrebuiltAsset(r, spec)?.name).toBe('llama-b5555-bin-win-cuda-cu12.4-x64.zip');
  });

  it('Windows + NVIDIA: falls back to ANY cuda asset when the exact toolkit version has no match', () => {
    const spec: PlatformSpec = { os: 'win32', arch: 'x64', gpuVendor: 'nvidia', cudaVersion: '13.0' };
    const r = release(['llama-b5555-bin-win-cuda-cu12.4-x64.zip', 'llama-b5555-bin-win-avx2-x64.zip']);
    expect(pickPrebuiltAsset(r, spec)?.name).toBe('llama-b5555-bin-win-cuda-cu12.4-x64.zip');
  });

  it('Windows + AMD: matches the hip asset', () => {
    const spec: PlatformSpec = { os: 'win32', arch: 'x64', gpuVendor: 'amd' };
    expect(pickPrebuiltAsset(release(['llama-b5555-bin-win-hip-x64.zip', 'llama-b5555-bin-win-avx2-x64.zip']), spec)?.name).toBe(
      'llama-b5555-bin-win-hip-x64.zip',
    );
  });

  it('Windows + no GPU: matches an avx2 CPU asset', () => {
    const spec: PlatformSpec = { os: 'win32', arch: 'x64', gpuVendor: 'none' };
    expect(pickPrebuiltAsset(release(['llama-b5555-bin-win-avx2-x64.zip']), spec)?.name).toBe('llama-b5555-bin-win-avx2-x64.zip');
  });

  it('never matches an asset that is not a .zip/.tar.gz (e.g. a checksum or signature file)', () => {
    const spec: PlatformSpec = { os: 'darwin', arch: 'arm64', gpuVendor: 'apple' };
    expect(pickPrebuiltAsset(release(['llama-b5555-bin-macos-arm64.zip.sha256']), spec)).toBeNull();
  });
});

describe('pickLatestRelease', () => {
  it('picks the first non-draft, non-prerelease release with assets (newest-first input)', () => {
    const releases: GhRelease[] = [
      { tag_name: 'b5556', assets: [], draft: true },
      { tag_name: 'b5555', assets: [{ name: 'x.zip', browser_download_url: 'https://x' }], prerelease: true },
      { tag_name: 'b5554', assets: [{ name: 'x.zip', browser_download_url: 'https://x' }] },
      { tag_name: 'b5553', assets: [{ name: 'x.zip', browser_download_url: 'https://x' }] },
    ];
    expect(pickLatestRelease(releases)?.tag_name).toBe('b5554');
  });

  it('returns null when nothing qualifies', () => {
    expect(pickLatestRelease([{ tag_name: 'b1', assets: [], draft: true }])).toBeNull();
    expect(pickLatestRelease([])).toBeNull();
  });
});

describe('cudaBuildCommands', () => {
  it("renders the proven CUDA/gcc-12/arch86 recipe (verified against this box's live build)", () => {
    const cmds = cudaBuildCommands({ sourceDir: '/src/llama.cpp', buildDir: '/src/llama.cpp/build', cudaArch: '86', cudaHostCompiler: '/usr/bin/g++-12', jobs: 8 });
    expect(cmds).toEqual([
      ['cmake', '-S', '/src/llama.cpp', '-B', '/src/llama.cpp/build', '-DCMAKE_BUILD_TYPE=Release', '-DGGML_CUDA=ON', '-DCMAKE_CUDA_ARCHITECTURES=86', '-DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-12'],
      ['cmake', '--build', '/src/llama.cpp/build', '--config', 'Release', '-j', '8'],
    ]);
  });

  it('omits -DCMAKE_CUDA_HOST_COMPILER when none is given (a distro whose default gcc is already CUDA-compatible)', () => {
    const cmds = cudaBuildCommands({ sourceDir: '/src', buildDir: '/build', cudaArch: '89', jobs: 4 });
    expect(cmds[0]).not.toContain(expect.stringContaining('CUDA_HOST_COMPILER'));
    expect(cmds[0].join(' ')).not.toContain('HOST_COMPILER');
  });
});

// ---------------------------------------------------------------------------------------
// resolveLlamaBinary orchestration — real temp dirs (fast, no real fs risk), injected
// fetchReleases/download/extract/exec so no network call or real build ever runs.
// ---------------------------------------------------------------------------------------

describe('resolveLlamaBinary', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'llama-binary-test-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const linuxNvidiaHw: DetectedHardware = {
    platform: 'linux',
    arch: 'x64',
    ramGB: 64,
    gpu: { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', vramGB: 24, computeCap: '8.6' },
    notes: [],
  };
  const macArmHw: DetectedHardware = { platform: 'darwin', arch: 'arm64', ramGB: 36, gpu: { vendor: 'apple', vramGB: 36, unifiedMemory: true }, notes: [] };

  const oneRelease: GhRelease[] = [{ tag_name: 'b5555', assets: [{ name: 'llama-b5555-bin-macos-arm64.zip', browser_download_url: 'https://example.com/a.zip' }] }];

  function noExecCallsExpected(): ExecFn {
    return async (cmd, args) => {
      throw new Error(`unexpected exec call: ${cmd} ${args.join(' ')}`);
    };
  }

  it('prebuilt path (macOS arm64): downloads+extracts the matched asset, writes the binary + manifest, returns ok', async () => {
    let downloadCalls = 0;
    let extractCalls = 0;
    const execCalls: string[] = [];
    const result = await resolveLlamaBinary(macArmHw, {
      home,
      fetchReleases: async () => oneRelease,
      download: async (url, destPath) => {
        downloadCalls++;
        expect(url).toBe('https://example.com/a.zip');
        await mkdir(destPath.split('/').slice(0, -1).join('/'), { recursive: true });
        await fsWriteFile(destPath, 'fake-zip-bytes');
        return { bytesWritten: 14, sha256: 'irrelevant-because-hashFile-recomputes-from-final-binary' };
      },
      extract: async (_archivePath, destDir) => {
        extractCalls++;
        // Simulate the archive containing the binary directly at its root.
        await mkdir(destDir, { recursive: true });
        await fsWriteFile(join(destDir, 'llama-server'), 'fake-binary-contents');
      },
      exec: noExecCallsExpected(), // a prebuilt hit must never shell out to build tooling
    });

    expect(downloadCalls).toBe(1);
    expect(extractCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.fromCache).toBeFalsy();
    expect(result.manifest?.source).toBe('prebuilt');
    expect(result.manifest?.version).toBe('b5555');
    expect(result.manifest?.platformKey).toBe('darwin-arm64-metal');
    expect(result.binPath).toBe(`${home}/.papercusp/backends/llama-server/b5555/darwin-arm64-metal/llama-server`);
  });

  it('a second call for the same hardware is a pure cache hit — no network/download/extract/exec', async () => {
    await resolveLlamaBinary(macArmHw, {
      home,
      fetchReleases: async () => oneRelease,
      download: async (_url, destPath) => {
        await mkdir(destPath.split('/').slice(0, -1).join('/'), { recursive: true });
        await fsWriteFile(destPath, 'fake-zip-bytes');
        return { bytesWritten: 14, sha256: 'x' };
      },
      extract: async (_a, destDir) => {
        await mkdir(destDir, { recursive: true });
        await fsWriteFile(join(destDir, 'llama-server'), 'fake-binary-contents');
      },
      exec: noExecCallsExpected(),
    });

    const second = await resolveLlamaBinary(macArmHw, {
      home,
      fetchReleases: async () => oneRelease, // still needed to resolve the version to look up
      download: async () => {
        throw new Error('should not download on a cache hit');
      },
      extract: async () => {
        throw new Error('should not extract on a cache hit');
      },
      exec: noExecCallsExpected(),
    });
    expect(second.ok).toBe(true);
    expect(second.fromCache).toBe(true);
    expect(second.manifest?.source).toBe('prebuilt');
  });

  it('re-provisions when the cached binary no longer matches its own recorded checksum (corruption, not silently served)', async () => {
    const first = await resolveLlamaBinary(macArmHw, {
      home,
      fetchReleases: async () => oneRelease,
      download: async (_url, destPath) => {
        await mkdir(destPath.split('/').slice(0, -1).join('/'), { recursive: true });
        await fsWriteFile(destPath, 'fake-zip-bytes');
        return { bytesWritten: 14, sha256: 'x' };
      },
      extract: async (_a, destDir) => {
        await mkdir(destDir, { recursive: true });
        await fsWriteFile(join(destDir, 'llama-server'), 'fake-binary-contents');
      },
      exec: noExecCallsExpected(),
    });
    expect(first.ok).toBe(true);
    // Corrupt the cached binary in place.
    await fsWriteFile(first.binPath!, 'tampered-bytes');

    let redownloaded = false;
    const second = await resolveLlamaBinary(macArmHw, {
      home,
      fetchReleases: async () => oneRelease,
      download: async (_url, destPath) => {
        redownloaded = true;
        await mkdir(destPath.split('/').slice(0, -1).join('/'), { recursive: true });
        await fsWriteFile(destPath, 'fake-zip-bytes');
        return { bytesWritten: 14, sha256: 'x' };
      },
      extract: async (_a, destDir) => {
        await mkdir(destDir, { recursive: true });
        await fsWriteFile(join(destDir, 'llama-server'), 'fake-binary-contents');
      },
      exec: noExecCallsExpected(),
    });
    expect(redownloaded).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.fromCache).toBeFalsy();
  });

  it('Linux+NVIDIA (no prebuilt asset published): falls to build-from-source, runs the proven recipe via exec, and caches the result', async () => {
    const execLog: string[] = [];
    const linuxRelease: GhRelease[] = [{ tag_name: 'b5555', assets: [{ name: 'llama-b5555-bin-ubuntu-x64.zip', browser_download_url: 'https://example.com/cpu.zip' }] }];
    // ^ Even though a release exists with a Linux asset, it's CPU-only — assetNameRules
    //   correctly yields no rule for linux+nvidia, so pickPrebuiltAsset must return null and
    //   this asset must never be considered a match.

    const result = await resolveLlamaBinary(linuxNvidiaHw, {
      home,
      cudaArch: '86',
      cudaHostCompiler: '/usr/bin/g++-12',
      fetchReleases: async () => linuxRelease,
      download: async () => {
        throw new Error('must not download — no prebuilt asset exists for linux+nvidia');
      },
      exec: (async (cmd, args) => {
        execLog.push([cmd, ...args].join(' '));
        if (cmd === 'nvcc') throw new Error('nvcc absent in this fake — detectCudaVersion degrades to undefined');
        if (cmd === 'git' && args[0] === 'clone') {
          await mkdir(args[2], { recursive: true });
          return { stdout: '', stderr: '' };
        }
        if (cmd === 'cmake' && args.includes('--build')) {
          const buildDir = args[args.indexOf('--build') + 1];
          const binDir = join(buildDir, 'bin');
          await mkdir(binDir, { recursive: true });
          await fsWriteFile(join(binDir, 'llama-server'), 'fake-built-binary');
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }) as ExecFn,
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.source).toBe('source-build');
    expect(result.manifest?.platformKey).toBe('linux-x64-cuda'); // cudaVersion unresolved -> no suffix
    expect(execLog.some((l) => l.startsWith('git clone'))).toBe(true);
    expect(execLog.some((l) => l.startsWith('git') && l.includes('checkout b5555'))).toBe(true);
    const configureLine = execLog.find((l) => l.startsWith('cmake -S'));
    expect(configureLine).toContain('-DCMAKE_CUDA_ARCHITECTURES=86');
    expect(configureLine).toContain('-DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-12');
  });

  it('is blocked (not thrown) when GitHub releases are unreachable', async () => {
    const result = await resolveLlamaBinary(macArmHw, {
      home,
      fetchReleases: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/could not reach GitHub/);
  });

  it('is blocked when a pinned version does not exist among the releases', async () => {
    const result = await resolveLlamaBinary(macArmHw, { home, version: 'b9999', fetchReleases: async () => oneRelease });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/no release tagged 'b9999'/);
  });

  it('is blocked when no usable release exists at all', async () => {
    const result = await resolveLlamaBinary(macArmHw, { home, fetchReleases: async () => [] });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/no usable/);
  });

  it('is blocked (not thrown) when a from-source build fails', async () => {
    const linuxRelease: GhRelease[] = [{ tag_name: 'b5555', assets: [{ name: 'llama-b5555-bin-ubuntu-x64.zip', browser_download_url: 'https://x' }] }];
    const result = await resolveLlamaBinary(linuxNvidiaHw, {
      home,
      cudaArch: '86',
      fetchReleases: async () => linuxRelease,
      exec: (async (cmd, args) => {
        if (cmd === 'git' && args[0] === 'clone') {
          await mkdir(args[2], { recursive: true });
          return { stdout: '', stderr: '' };
        }
        if (cmd === 'cmake' && args.includes('--build')) throw new Error('nvcc fatal: unsupported host compiler');
        return { stdout: '', stderr: '' };
      }) as ExecFn,
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/build-from-source failed/);
  });
});
