import { describe, expect, it, vi } from 'vitest';
import { planProvision, applyProvision } from './provision';
import type { CatalogEntry } from './catalog';

const nvidia24gbHardwareDeps = {
  exec: async (cmd: string, args: string[]) => {
    if (cmd === 'nvidia-smi') return { stdout: 'NVIDIA GeForce RTX 3090, 24576\n', stderr: '' };
    throw new Error('unexpected command');
  },
  platform: 'linux' as const,
  arch: 'x64',
  totalMemBytes: 64 * 1024 ** 3,
};

const cpuOnlyHardwareDeps = {
  exec: async () => {
    throw new Error('no gpu tooling');
  },
  platform: 'linux' as const,
  arch: 'x64',
  totalMemBytes: 16 * 1024 ** 3,
};

// planProvision() only probes for a container runtime on NVIDIA hardware (D-004: vLLM is
// CUDA-only) — every nvidia24gbHardwareDeps case below hits that probe, so inject a
// deterministic "no runtime" exec rather than letting it shell out to this box's real
// docker/podman (hermetic + fast, matches every other injected-deps test in this file).
const noContainerRuntimeVllmDeps = {
  exec: async () => {
    throw new Error('no container runtime in test env');
  },
};

describe('planProvision', () => {
  it('produces a ready-to-apply plan when weights are already present (real ornith shape)', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      vllmDeps: noContainerRuntimeVllmDeps,
      ollamaDeps: {
        exists: () => true,
        readFile: async () =>
          JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc123' }] }),
      },
      home: '/home/testuser',
    });
    expect(plan.blocked).toBeNull();
    expect(plan.recommendation.entry?.id).toBe('ornith-35b-iq3m-llama-server');
    expect(plan.weights?.needsDownload).toBe(false);
    expect(plan.unitFileContent).toContain('ExecStart=llama-server');
    expect(plan.unitFilePath).toBe('/home/testuser/.config/systemd/user/provisioner-ornith-35b-iq3m-llama-server.service');
    expect(plan.gatewayRegisterInput).toEqual({
      id: 'provisioner-ornith-35b-iq3m-llama-server',
      kind: 'llama-server',
      baseUrl: 'http://127.0.0.1:11436',
      models: ['maxwell1500/ornith-35b:IQ3_M'],
      maxConcurrent: 2,
    });
  });

  it('is blocked with a pull hint when weights are not present locally', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      vllmDeps: noContainerRuntimeVllmDeps,
      ollamaDeps: { exists: () => false, readFile: async () => '' },
    });
    expect(plan.blocked).toMatch(/ollama pull/);
    expect(plan.unitFileContent).toBeNull();
    expect(plan.gatewayRegisterInput).toBeNull();
  });

  it('is blocked with a cloud-fallback reason on cpu-only hardware — never calls the weights resolver', async () => {
    const ollamaDeps = { exists: vi.fn(() => false), readFile: vi.fn(async () => '') };
    const plan = await planProvision({ hardwareDeps: cpuOnlyHardwareDeps, ollamaDeps });
    expect(plan.blocked).toMatch(/cloud gateway/);
    expect(ollamaDeps.exists).not.toHaveBeenCalled();
  });

  // A synthetic vllm catalog entry — no real one exists yet (P-008, still `todo`, is what
  // grounds a certified/provisional AWQ entry). This proves provision.ts's vllm branch
  // (D-009 #3/P-013) end-to-end without waiting on that cert battery.
  const vllmCatalog: CatalogEntry[] = [
    {
      id: 'ornith-35b-awq-vllm',
      displayName: 'ornith-35b (AWQ) via vLLM',
      backend: 'vllm',
      model: { ollamaRef: 'ornith-35b-awq', quant: 'AWQ', sizeGB: 19, hfRepo: 'maxwell1500/ornith-35b-AWQ', quantization: 'awq' },
      hardwareTier: 'nvidia-24gb-plus',
      minVramGB: 24,
      serve: { host: '127.0.0.1', portDefault: 8000, parallelSlots: 4, ctxTotal: 65536, kvCacheType: 'n/a', flashAttn: false, gpuMemoryUtilization: 0.9 },
      status: 'provisional',
      sourceRef: 'test fixture — no real vLLM catalog entry exists yet',
    },
  ];

  it('produces a vllm container plan when a working container runtime is detected and the image is cached', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      catalog: vllmCatalog,
      vllmDeps: {
        exec: async (cmd: string, args: string[]) => {
          if (cmd === 'docker' && args[0] === 'info') return { stdout: '"29.4.0"', stderr: '' };
          if (cmd === 'docker' && args[0] === 'image') return { stdout: 'sha256:abc', stderr: '' };
          throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
        },
      },
      home: '/home/testuser',
    });
    expect(plan.blocked).toBeNull();
    expect(plan.containerRuntime?.runtime).toBe('docker');
    expect(plan.recommendation.entry?.id).toBe('ornith-35b-awq-vllm');
    expect(plan.unitFileContent).toContain('ExecStart=docker run --rm --name provisioner-ornith-35b-awq-vllm');
    expect(plan.unitFileContent).toContain('--model maxwell1500/ornith-35b-AWQ');
    expect(plan.unitFileContent).toContain('--quantization awq');
    expect(plan.gatewayRegisterInput).toEqual({
      id: 'provisioner-ornith-35b-awq-vllm',
      kind: 'vllm',
      baseUrl: 'http://127.0.0.1:8000',
      models: ['ornith-35b-awq'],
      maxConcurrent: 4,
    });
  });

  it('is blocked with a pullHint (never renders a unit) when the image is not cached yet', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      catalog: vllmCatalog,
      vllmDeps: {
        exec: async (cmd: string, args: string[]) => {
          if (cmd === 'docker' && args[0] === 'info') return { stdout: '"29.4.0"', stderr: '' };
          throw new Error('no such image');
        },
      },
    });
    expect(plan.blocked).toMatch(/docker pull/);
    expect(plan.unitFileContent).toBeNull();
    expect(plan.gatewayRegisterInput).toBeNull();
  });

  it('downgrades to the llama-server candidate when no working container runtime is found, for a tier with both', async () => {
    const mixedCatalog: CatalogEntry[] = [
      ...vllmCatalog,
      {
        id: 'ornith-35b-iq3m-llama-server',
        displayName: 'ornith-35b (IQ3_M) via llama-server',
        backend: 'llama-server',
        model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M', quant: 'IQ3_M', sizeGB: 15.5 },
        hardwareTier: 'nvidia-24gb-plus',
        minVramGB: 24,
        serve: { host: '127.0.0.1', portDefault: 11436, parallelSlots: 2, ctxTotal: 180224, kvCacheType: 'q8_0', flashAttn: true },
        status: 'provisional',
        sourceRef: 'test fixture',
      },
    ];
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      catalog: mixedCatalog,
      vllmDeps: noContainerRuntimeVllmDeps,
      ollamaDeps: {
        exists: () => true,
        readFile: async () =>
          JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc123' }] }),
      },
    });
    // vllm's sizeGB (19) < llama-server's (15.5)? No — 19 > 15.5, so vllm would normally win on
    // size; the container-runtime gate is what forces the llama-server fallback here.
    expect(plan.recommendation.entry?.backend).toBe('llama-server');
    expect(plan.recommendation.reason).toMatch(/vLLM candidate was skipped/);
    expect(plan.blocked).toBeNull();
  });
});

describe('applyProvision', () => {
  it('refuses to apply a blocked plan without writing/registering anything', async () => {
    const plan = await planProvision({ hardwareDeps: cpuOnlyHardwareDeps });
    const writeFile = vi.fn();
    const registerBackend = vi.fn();
    const result = await applyProvision(plan, { writeFile, registerBackend });
    expect(result.ok).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
    expect(registerBackend).not.toHaveBeenCalled();
  });

  it('writes the unit + registers the backend, and NEVER touches systemd/GPU when start is omitted', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      vllmDeps: noContainerRuntimeVllmDeps,
      ollamaDeps: {
        exists: () => true,
        readFile: async () =>
          JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc123' }] }),
      },
    });
    const writeFile = vi.fn(async () => {});
    const mkdir = vi.fn(async () => {});
    const registerBackend = vi.fn(async (input) => ({ ...input, createdAt: 'now', updatedAt: 'now', enabled: true }));
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const healthCheck = vi.fn(async () => true);

    const result = await applyProvision(plan, { writeFile, mkdir, registerBackend, runSystemctl, healthCheck });

    expect(result).toEqual({ ok: true, wroteUnit: true, registered: true, started: false });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(registerBackend).toHaveBeenCalledTimes(1);
    expect(runSystemctl).not.toHaveBeenCalled();
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it('only touches systemd/GPU when start:true is explicitly passed', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      vllmDeps: noContainerRuntimeVllmDeps,
      ollamaDeps: {
        exists: () => true,
        readFile: async () =>
          JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc123' }] }),
      },
    });
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const healthCheck = vi.fn(async () => true);
    const result = await applyProvision(plan, {
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      registerBackend: vi.fn(async (input) => ({ ...input, createdAt: 'now', updatedAt: 'now', enabled: true })),
      runSystemctl,
      healthCheck,
      start: true,
    });
    expect(result.started).toBe(true);
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'daemon-reload']);
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'enable', '--now', 'provisioner-ornith-35b-iq3m-llama-server.service']);
    expect(healthCheck).toHaveBeenCalledWith('http://127.0.0.1:11436');
  });
});
