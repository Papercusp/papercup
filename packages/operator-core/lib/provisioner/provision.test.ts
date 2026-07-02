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

describe('planProvision', () => {
  it('produces a ready-to-apply plan when weights are already present (real ornith shape)', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
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
