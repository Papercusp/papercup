import { describe, expect, it } from 'vitest';
import { detectHardware, type ExecFn } from './hardware-detect';

/** Build an injected exec that answers per-command from a lookup table, erroring for anything unlisted. */
function execFrom(table: Record<string, { stdout: string; stderr?: string } | Error>): ExecFn {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const hit = table[key] ?? table[cmd];
    if (!hit) throw new Error(`no such command: ${cmd}`);
    if (hit instanceof Error) throw hit;
    return { stdout: hit.stdout, stderr: hit.stderr ?? '' };
  };
}

describe('detectHardware', () => {
  it('reports an NVIDIA GPU + compute_cap from nvidia-smi output (real ornith-box shape)', async () => {
    const exec = execFrom({
      'nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits': {
        stdout: 'NVIDIA GeForce RTX 3090, 24576, 8.6\n',
      },
    });
    const hw = await detectHardware({ exec, platform: 'linux', arch: 'x64', totalMemBytes: 64 * 1024 ** 3 });
    expect(hw.gpu).toEqual({ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', vramGB: 24, computeCap: '8.6' });
    expect(hw.platform).toBe('linux');
    expect(hw.ramGB).toBe(64);
    expect(hw.notes).toHaveLength(0);
  });

  it('degrades to computeCap:undefined (+ a note) when nvidia-smi omits the field, not a probe failure', async () => {
    const exec = execFrom({
      'nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits': {
        stdout: 'NVIDIA GeForce RTX 3090, 24576\n',
      },
    });
    const hw = await detectHardware({ exec, platform: 'linux', arch: 'x64', totalMemBytes: 64 * 1024 ** 3 });
    expect(hw.gpu).toEqual({ vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', vramGB: 24, computeCap: undefined });
    expect(hw.notes.some((n) => n.includes('compute_cap'))).toBe(true);
  });

  it('falls back to AMD when nvidia-smi is absent and rocm-smi answers', async () => {
    const exec = execFrom({
      'nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits': new Error('command not found'),
      'rocm-smi --showproductname --showmeminfo vram --json': {
        stdout: JSON.stringify({
          card0: { 'Card series': 'Radeon RX 7900 XTX', 'VRAM Total Memory (B)': String(24 * 1024 ** 3) },
        }),
      },
    });
    const hw = await detectHardware({ exec, platform: 'linux', arch: 'x64', totalMemBytes: 32 * 1024 ** 3 });
    expect(hw.gpu).toEqual({ vendor: 'amd', model: 'Radeon RX 7900 XTX', vramGB: 24 });
  });

  it('reports unified memory for Apple Silicon without shelling out to nvidia/rocm', async () => {
    const exec = execFrom({
      'sysctl -n machdep.cpu.brand_string': { stdout: 'Apple M3 Max\n' },
    });
    const hw = await detectHardware({ exec, platform: 'darwin', arch: 'arm64', totalMemBytes: 36 * 1024 ** 3 });
    expect(hw.gpu).toEqual({ vendor: 'apple', model: 'Apple M3 Max', vramGB: 36, unifiedMemory: true });
  });

  it('is fail-soft: no GPU tooling present yields gpu:null + a note, never a throw', async () => {
    const exec = execFrom({});
    const hw = await detectHardware({ exec, platform: 'linux', arch: 'x64', totalMemBytes: 16 * 1024 ** 3 });
    expect(hw.gpu).toBeNull();
    expect(hw.notes.length).toBeGreaterThan(0);
  });

  it('is fail-soft against malformed nvidia-smi output', async () => {
    const exec = execFrom({
      'nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits': { stdout: 'not,a,valid,line\n' },
    });
    const hw = await detectHardware({ exec, platform: 'linux', arch: 'x64', totalMemBytes: 16 * 1024 ** 3 });
    expect(hw.gpu).toBeNull();
    expect(hw.notes.some((n) => n.includes('nvidia-smi'))).toBe(true);
  });

  it('treats Intel Macs (darwin/x64) as cpu-only rather than guessing VRAM', async () => {
    const exec = execFrom({});
    const hw = await detectHardware({ exec, platform: 'darwin', arch: 'x64', totalMemBytes: 16 * 1024 ** 3 });
    expect(hw.gpu).toBeNull();
    expect(hw.notes.some((n) => n.includes('Intel Mac'))).toBe(true);
  });

  it('defaults exec/platform/arch/totalMemBytes to real process values when not injected', async () => {
    const hw = await detectHardware();
    expect(typeof hw.platform).toBe('string');
    expect(typeof hw.arch).toBe('string');
    expect(hw.ramGB).toBeGreaterThan(0);
  });
});
