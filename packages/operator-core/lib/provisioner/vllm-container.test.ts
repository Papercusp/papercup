import { describe, expect, it, vi } from 'vitest';
import {
  detectContainerRuntime,
  resolveVllmImage,
  pullVllmImage,
  renderVllmContainerUnit,
  renderVllmDetachedRunArgs,
  VLLM_PINNED_IMAGE,
  type ExecFn,
} from './vllm-container';

describe('detectContainerRuntime', () => {
  it('picks docker when it answers a version query', async () => {
    const exec: ExecFn = vi.fn(async (cmd) => {
      if (cmd === 'docker') return { stdout: '"29.4.0"\n', stderr: '' };
      throw new Error('unexpected command');
    });
    const info = await detectContainerRuntime(exec);
    expect(info.runtime).toBe('docker');
    expect(info.version).toBe('29.4.0');
  });

  it('falls back to podman when docker is not usable', async () => {
    const exec: ExecFn = vi.fn(async (cmd) => {
      if (cmd === 'docker') throw new Error('ENOENT');
      if (cmd === 'podman') return { stdout: JSON.stringify({ version: { Version: '5.2.1' } }), stderr: '' };
      throw new Error('unexpected command');
    });
    const info = await detectContainerRuntime(exec);
    expect(info.runtime).toBe('podman');
    expect(info.version).toBe('5.2.1');
    expect(info.notes.some((n) => n.includes('docker not usable'))).toBe(true);
  });

  it('returns runtime:null with an explanatory note when neither is usable — never throws', async () => {
    const exec: ExecFn = vi.fn(async () => {
      throw new Error('command not found');
    });
    const info = await detectContainerRuntime(exec);
    expect(info.runtime).toBeNull();
    expect(info.notes.some((n) => n.includes('downgrade to llama-server'))).toBe(true);
  });
});

describe('resolveVllmImage', () => {
  it('reports needsDownload:false with weightsPath=image when already cached — never pulls', async () => {
    const exec: ExecFn = vi.fn(async (cmd, args) => {
      if (args[0] === 'image') return { stdout: 'sha256:abc\n', stderr: '' };
      throw new Error('unexpected exec');
    });
    const plan = await resolveVllmImage('vllm/vllm-openai:v0.24.0', {
      runtimeInfo: { runtime: 'docker', notes: [] },
      exec,
    });
    expect(plan.needsDownload).toBe(false);
    expect(plan.weightsPath).toBe('vllm/vllm-openai:v0.24.0');
    expect(exec).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['pull']));
  });

  it('reports needsDownload:true with a runtime-specific pullHint when not cached', async () => {
    const exec: ExecFn = vi.fn(async () => {
      throw new Error('no such image');
    });
    const plan = await resolveVllmImage(VLLM_PINNED_IMAGE, { runtimeInfo: { runtime: 'podman', notes: [] }, exec });
    expect(plan.needsDownload).toBe(true);
    expect(plan.pullHint).toBe(`podman pull ${VLLM_PINNED_IMAGE}`);
  });

  it('reports needsDownload:true with a downgrade-to-llama-server detail when no runtime is available', async () => {
    const plan = await resolveVllmImage(VLLM_PINNED_IMAGE, {
      runtimeInfo: { runtime: null, notes: ['no docker', 'no podman'] },
    });
    expect(plan.needsDownload).toBe(true);
    expect(plan.pullHint).toBeUndefined();
    expect(plan.detail).toMatch(/downgrade to llama-server/);
  });
});

describe('pullVllmImage', () => {
  it('skips the pull and reports alreadyPresent:true when the image is already cached', async () => {
    const exec: ExecFn = vi.fn(async (cmd, args) => {
      if (args[0] === 'image') return { stdout: 'sha256:abc', stderr: '' };
      throw new Error('unexpected — should not pull');
    });
    const result = await pullVllmImage(VLLM_PINNED_IMAGE, { runtimeInfo: { runtime: 'docker', notes: [] }, exec });
    expect(result).toEqual({ ok: true, runtime: 'docker', image: VLLM_PINNED_IMAGE, alreadyPresent: true });
  });

  it('pulls when not cached and reports alreadyPresent:false on success', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = vi.fn(async (cmd, args) => {
      calls.push(args);
      if (args[0] === 'image') throw new Error('no such image');
      if (args[0] === 'pull') return { stdout: '', stderr: '' };
      throw new Error('unexpected exec');
    });
    const result = await pullVllmImage(VLLM_PINNED_IMAGE, { runtimeInfo: { runtime: 'docker', notes: [] }, exec });
    expect(result).toEqual({ ok: true, runtime: 'docker', image: VLLM_PINNED_IMAGE, alreadyPresent: false });
    expect(calls.some((a) => a[0] === 'pull' && a[1] === VLLM_PINNED_IMAGE)).toBe(true);
  });

  it('is blocked with the runtime/image context when the pull itself fails', async () => {
    const exec: ExecFn = vi.fn(async (cmd, args) => {
      if (args[0] === 'image') throw new Error('no such image');
      if (args[0] === 'pull') throw new Error('network unreachable');
      throw new Error('unexpected exec');
    });
    const result = await pullVllmImage(VLLM_PINNED_IMAGE, { runtimeInfo: { runtime: 'docker', notes: [] }, exec });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/docker pull .* failed: network unreachable/);
  });

  it('is blocked without attempting any exec when no runtime is available', async () => {
    const exec: ExecFn = vi.fn();
    const result = await pullVllmImage(VLLM_PINNED_IMAGE, { runtimeInfo: { runtime: null, notes: ['nothing found'] }, exec });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/downgrade to llama-server/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('renderVllmContainerUnit', () => {
  const baseOpts = {
    runtime: 'docker' as const,
    containerName: 'provisioner-ornith-awq-vllm',
    image: VLLM_PINNED_IMAGE,
    hfModelRepo: 'maxwell1500/ornith-35b-AWQ',
    servedModelName: 'ornith-35b-awq',
    quantization: 'awq' as const,
    host: '127.0.0.1',
    port: 8000,
    maxModelLen: 65536,
    gpuMemoryUtilization: 0.9,
    hfCacheDir: '/home/testuser/.cache/huggingface',
    logPath: '/home/testuser/.papercusp/provisioner-vllm.log',
  };

  it('renders a docker-backed unit with the pinned image and AWQ config', () => {
    const unit = renderVllmContainerUnit(baseOpts);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Requires=docker.service');
    expect(unit).toContain('ExecStart=docker run --rm --name provisioner-ornith-awq-vllm');
    expect(unit).toContain('--gpus all');
    expect(unit).toContain('-p 127.0.0.1:8000:8000');
    expect(unit).toContain('-v /home/testuser/.cache/huggingface:/root/.cache/huggingface');
    expect(unit).toContain(VLLM_PINNED_IMAGE);
    expect(unit).toContain('--model maxwell1500/ornith-35b-AWQ');
    expect(unit).toContain('--served-model-name ornith-35b-awq');
    expect(unit).toContain('--quantization awq');
    expect(unit).toContain('--max-model-len 65536');
    expect(unit).toContain('--gpu-memory-utilization 0.9');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('omits the docker.service Requires/After for a podman runtime', () => {
    const unit = renderVllmContainerUnit({ ...baseOpts, runtime: 'podman' });
    expect(unit).not.toContain('Requires=docker.service');
    expect(unit).not.toContain('docker.service');
    expect(unit).toContain('ExecStart=podman run --rm');
  });

  it('embeds an HF token env line only when supplied', () => {
    const withToken = renderVllmContainerUnit({ ...baseOpts, hfToken: 'hf_secret123' });
    expect(withToken).toContain('-e HUGGING_FACE_HUB_TOKEN=hf_secret123');
    const withoutToken = renderVllmContainerUnit(baseOpts);
    expect(withoutToken).not.toContain('HUGGING_FACE_HUB_TOKEN');
  });

  it('honors gptq quantization and a custom image pin', () => {
    const unit = renderVllmContainerUnit({ ...baseOpts, quantization: 'gptq', image: 'vllm/vllm-openai:v0.25.0' });
    expect(unit).toContain('--quantization gptq');
    expect(unit).toContain('vllm/vllm-openai:v0.25.0');
  });
});

describe('renderVllmDetachedRunArgs', () => {
  it('renders a detached, restart-policy argv for non-systemd platforms', () => {
    const args = renderVllmDetachedRunArgs({
      runtime: 'docker',
      containerName: 'papercusp-vllm-ornith',
      image: VLLM_PINNED_IMAGE,
      hfModelRepo: 'maxwell1500/ornith-35b-AWQ',
      servedModelName: 'ornith-35b-awq',
      quantization: 'awq',
      host: '127.0.0.1',
      port: 8000,
      maxModelLen: 65536,
      gpuMemoryUtilization: 0.9,
      hfCacheDir: '/Users/test/.cache/huggingface',
    });
    expect(args[0]).toBe('run');
    expect(args).toContain('-d');
    expect(args).toContain('unless-stopped');
    expect(args).toContain('--gpus');
    expect(args).toContain(VLLM_PINNED_IMAGE);
    expect(args).toContain('--quantization');
    expect(args).toContain('awq');
  });

  it('appends an HF token env pair only when supplied', () => {
    const withToken = renderVllmDetachedRunArgs({
      runtime: 'podman',
      containerName: 'x',
      image: VLLM_PINNED_IMAGE,
      hfModelRepo: 'r',
      servedModelName: 's',
      quantization: 'gptq',
      host: '0.0.0.0',
      port: 8000,
      maxModelLen: 4096,
      gpuMemoryUtilization: 0.8,
      hfCacheDir: '/hf',
      hfToken: 'hf_abc',
    });
    expect(withToken).toContain('-e');
    expect(withToken).toContain('HUGGING_FACE_HUB_TOKEN=hf_abc');
  });
});
