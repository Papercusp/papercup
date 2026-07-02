/**
 * provisioner-install-binary.test.ts — the `provisioner:install` tool's `provisionBinary:true`
 * branch (WI-1617/D-009 #2, mirroring `local-model-install.test.ts`'s equivalent HTTP-route
 * coverage). Kept in its own file (rather than provisioner.test.ts) because this branch calls
 * into `detectHardware`/`resolveLlamaBinary`/`planProvision`/`applyProvision` — all of which are
 * REAL, un-mocked, real-I/O calls in provisioner.test.ts by deliberate design (that file's own
 * header: "provisioner:install is NOT exercised here — it performs real writes"). This file
 * mocks all four so the branch's wiring (hardware → binary resolution → binPath threaded into
 * planProvision → applyProvision) is provable without ever touching the network, a real build
 * toolchain, systemd, or Postgres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const planProvisionMock = vi.fn();
const applyProvisionMock = vi.fn();
vi.mock('../../provisioner/provision', () => ({
  planProvision: (...args: unknown[]) => planProvisionMock(...args),
  applyProvision: (...args: unknown[]) => applyProvisionMock(...args),
}));

const detectHardwareMock = vi.fn();
vi.mock('../../provisioner/hardware-detect', () => ({
  detectHardware: (...args: unknown[]) => detectHardwareMock(...args),
}));

const resolveLlamaBinaryMock = vi.fn();
vi.mock('../../provisioner/llama-binary', () => ({
  resolveLlamaBinary: (...args: unknown[]) => resolveLlamaBinaryMock(...args),
  computeCapToArch: (cc: string) => cc.replace(/\./g, ''),
}));

// recommendCombo is used by provisioner:recommend, not provisioner:install — mock it too so
// importing ./provisioner never triggers a real hardware probe for an unrelated tool.
vi.mock('../../provisioner/recommend', () => ({ recommendCombo: vi.fn() }));

import { provisionerInstallTool } from './provisioner';

const body = (o: unknown) => JSON.parse((o as { content: { text: string }[] }).content[0]!.text);

beforeEach(() => {
  planProvisionMock.mockClear();
  applyProvisionMock.mockClear();
  detectHardwareMock.mockClear();
  resolveLlamaBinaryMock.mockClear();
});

describe('provisioner:install provisionBinary (WI-1617)', () => {
  it('omits binPath and never touches hardware-detect/llama-binary when provisionBinary is omitted', async () => {
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });

    const r = body(await provisionerInstallTool.handler({}, {} as never));

    expect(detectHardwareMock).not.toHaveBeenCalled();
    expect(resolveLlamaBinaryMock).not.toHaveBeenCalled();
    expect(planProvisionMock).toHaveBeenCalledWith({ binPath: undefined });
    expect(r.ok).toBe(true);
  });

  it('resolves a binary and threads binPath into planProvision when provisionBinary:true', async () => {
    const hw = { platform: 'linux', arch: 'x64', ramGB: 32, gpu: { vendor: 'nvidia', vramGB: 24, computeCap: '8.6' }, notes: [] };
    detectHardwareMock.mockResolvedValue(hw);
    resolveLlamaBinaryMock.mockResolvedValue({ ok: true, binPath: '/home/u/.papercusp/backends/llama-server/b1/linux-x64-cuda/llama-server', fromCache: true });
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });

    const r = body(await provisionerInstallTool.handler({ provisionBinary: true }, {} as never));

    expect(resolveLlamaBinaryMock).toHaveBeenCalledWith(hw, { cudaArch: '86', cudaHostCompiler: undefined });
    expect(planProvisionMock).toHaveBeenCalledWith({ binPath: '/home/u/.papercusp/backends/llama-server/b1/linux-x64-cuda/llama-server' });
    expect(r.ok).toBe(true);
  });

  it('fails the whole call (never falls back to a bare-PATH assumption) when binary resolution is blocked', async () => {
    detectHardwareMock.mockResolvedValue({ platform: 'linux', arch: 'x64', ramGB: 32, gpu: null, notes: [] });
    resolveLlamaBinaryMock.mockResolvedValue({ ok: false, blocked: 'no usable release found' });

    const r = body(await provisionerInstallTool.handler({ provisionBinary: true }, {} as never));

    expect(r.ok).toBe(false);
    expect(r.error).toContain('no usable release found');
    expect(planProvisionMock).not.toHaveBeenCalled();
    expect(applyProvisionMock).not.toHaveBeenCalled();
  });

  it('still honors start:true alongside provisionBinary:true', async () => {
    const hw = { platform: 'darwin', arch: 'arm64', ramGB: 36, gpu: { vendor: 'apple', vramGB: 36, unifiedMemory: true }, notes: [] };
    detectHardwareMock.mockResolvedValue(hw);
    resolveLlamaBinaryMock.mockResolvedValue({ ok: true, binPath: '/home/u/.papercusp/backends/llama-server/b1/macos-arm64-metal/llama-server' });
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: true });

    await provisionerInstallTool.handler({ provisionBinary: true, start: true }, {} as never);

    expect(resolveLlamaBinaryMock).toHaveBeenCalledWith(hw, { cudaArch: undefined, cudaHostCompiler: undefined });
    expect(applyProvisionMock).toHaveBeenCalledWith(expect.anything(), { start: true });
  });
});
