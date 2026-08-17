import { describe, expect, it, vi } from 'vitest';
import {
  planProvision,
  applyProvision,
  stopLocalBackend,
  ensureLocalBackendRunning,
  type BackendLifecycleTarget,
} from './provision';
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
      // The catalog entry marks this combo on-demand (it occupies a whole 24GB card), and the
      // plan must carry that into the REGISTRY, which is what the reaper and gateway read — the
      // catalog itself is only a recommendation source (D-005).
      lifecycle: 'on-demand',
      idleTtlSec: 1800,
      // Captured here rather than inferred from baseUrl later: for a backend fronted by a proxy
      // those are different processes, and guessing stops the wrong one (D-005).
      unitName: 'provisioner-ornith-35b-iq3m-llama-server.service',
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
      // This fixture's catalog entry says nothing about lifecycle, and the default is the whole
      // safety argument for the field: an entry that is silent — including any third-party
      // catalog written before 843 existed — stays always-on and never becomes reapable.
      lifecycle: 'always-on',
      idleTtlSec: null,
      unitName: 'provisioner-ornith-35b-awq-vllm.service',
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

/* ── Runtime lifecycle seam (P-006) ───────────────────────────────────────────────────────
 *
 * The shape under test is the REAL, MEASURED ornith topology, because it is the one that
 * makes the bug possible: baseUrl points at the always-on proxy (:11435) while the unit that
 * actually holds the GPU is `llama-ornith.service` (:11436). A "stop whatever serves baseUrl"
 * implementation passes any test whose fixture has those agreeing — so they must not agree
 * here (D-005). */
const ORNITH: BackendLifecycleTarget = {
  id: 'ornith-llamaserver',
  unitName: 'llama-ornith.service',
  baseUrl: 'http://127.0.0.1:11435',
};

/** Deterministic clock: `sleep` advances it, so a 10-minute timeout costs no wall-clock. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('stopLocalBackend', () => {
  it('stops the RECORDED unit, never one derived from baseUrl', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await stopLocalBackend(ORNITH, { runSystemctl });

    expect(result).toMatchObject({ ok: true, stopped: true, unitName: 'llama-ornith.service' });
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'stop', 'llama-ornith.service']);
    // The port that is NOT the unit's must never appear in an argv — that is the exact
    // mistake (stopping the proxy, leaving 19.8GB resident) this asserts against.
    expect(JSON.stringify(runSystemctl.mock.calls)).not.toContain('11435');
  });

  it('REFUSES a backend with no recorded unit, without touching systemd', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await stopLocalBackend({ ...ORNITH, unitName: null }, { runSystemctl });

    expect(result.ok).toBe(false);
    expect(result.stopped).toBe(false);
    expect(result.error).toMatch(/no unitName recorded/);
    expect(runSystemctl).not.toHaveBeenCalled();
  });

  it('never issues `disable` — boot policy is not an idle sweep\'s to change', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await stopLocalBackend(ORNITH, { runSystemctl });
    expect(JSON.stringify(runSystemctl.mock.calls)).not.toContain('disable');
  });

  it('reports a systemctl failure instead of claiming the backend stopped', async () => {
    const result = await stopLocalBackend(ORNITH, {
      runSystemctl: async () => {
        throw new Error('Unit llama-ornith.service not loaded.');
      },
    });
    expect(result).toMatchObject({ ok: false, stopped: false });
    expect(result.error).toMatch(/not loaded/);
  });
});

describe('ensureLocalBackendRunning', () => {
  it('costs one health probe and no subprocess when the backend is already up', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const healthCheck = vi.fn(async () => true);

    const result = await ensureLocalBackendRunning(ORNITH, {
      readyTimeoutMs: 600_000,
      runSystemctl,
      healthCheck,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: true, alreadyRunning: true, started: false, healthy: true, waitedMs: 0 });
    expect(runSystemctl).not.toHaveBeenCalled();
    expect(healthCheck).toHaveBeenCalledTimes(1);
    // Health is judged at the ROUTABLE address, not the unit's own port.
    expect(healthCheck).toHaveBeenCalledWith('http://127.0.0.1:11435');
  });

  it('starts the recorded unit and waits out a cold load', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    let probes = 0;
    const healthCheck = vi.fn(async () => ++probes > 4); // unhealthy for the first 4 probes

    const result = await ensureLocalBackendRunning(ORNITH, {
      readyTimeoutMs: 600_000,
      pollIntervalMs: 1000,
      runSystemctl,
      healthCheck,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: true, alreadyRunning: false, started: true, healthy: true });
    expect(result.waitedMs).toBe(4000); // 1 pre-probe + 4 polls at 1s
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'start', 'llama-ornith.service']);
  });

  it('gives up at readyTimeoutMs and leaves the unit RUNNING', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));

    const result = await ensureLocalBackendRunning(ORNITH, {
      readyTimeoutMs: 30_000,
      pollIntervalMs: 1000,
      runSystemctl,
      healthCheck: async () => false,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: false, started: true, healthy: false });
    expect(result.waitedMs).toBe(30_000);
    expect(result.error).toMatch(/did not answer/);
    // A part-loaded model is worth more than a clean slate — no stop on the way out.
    expect(JSON.stringify(runSystemctl.mock.calls)).not.toContain('stop');
  });

  it('REFUSES to start a backend with no recorded unit (after finding it unhealthy)', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await ensureLocalBackendRunning(
      { ...ORNITH, unitName: null },
      { readyTimeoutMs: 600_000, runSystemctl, healthCheck: async () => false, ...fakeClock() },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no unitName recorded/);
    expect(runSystemctl).not.toHaveBeenCalled();
  });

  it('propagates a start failure rather than waiting out the full timeout', async () => {
    const result = await ensureLocalBackendRunning(ORNITH, {
      readyTimeoutMs: 600_000,
      runSystemctl: async () => {
        throw new Error('Failed to start llama-ornith.service: Unit not found.');
      },
      healthCheck: async () => false,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: false, started: false, healthy: false });
    expect(result.error).toMatch(/Unit not found/);
    expect(result.waitedMs).toBe(0);
  });
});
