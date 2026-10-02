/**
 * WI-10005481: two Papercusp Servers on one Linux host (one user each) must not share the
 * fixed-port inference gateway (:8788) or MCP proxy (:9071). These tests pin the port
 * decision (by LISTEN-socket uid) and the gateway supervisor's refusal to adopt a listener
 * another uid owns. The census is injected; the parser it sits on is covered against real
 * /proc/net/tcp text in sidecar-spawn-shared.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_TENANT_SERVICE,
  MCP_PROXY_TENANT_SERVICE,
  loopbackPortHeldByForeignUid,
  pinTenantLoopbackPort,
  pinTenantLoopbackPorts,
  resolveTenantLoopbackPort,
} from './tenant-loopback-port';
import {
  _gatewaySidecarStateForTests,
  _resetGatewaySidecarStateForTests,
  ensureGatewaySidecar,
  stopGatewaySidecar,
} from '../inference-gateway/gateway-sidecar-spawn';

/** A fake LISTEN census: port -> owning uids. Unlisted ports are free. */
function census(holders: Record<number, number[]>): (port: number) => number[] {
  return (port) => holders[port] ?? [];
}

const T1 = 1002; // tenant 1 (pct1 on cap-p011)
const T2 = 1003; // tenant 2 (pct2 on cap-p011)

describe('resolveTenantLoopbackPort', () => {
  it('keeps the default when nothing listens there', () => {
    const d = resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, { env: {}, uid: T1, listenerUids: census({}) });
    expect(d).toEqual({ port: 8788, reason: 'default-free', moved: false, foreignUids: [] });
  });

  it('keeps (adopts) the default when THIS uid owns the listener — the dev-box systemd gateway', () => {
    const d = resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, {
      env: {},
      uid: T1,
      listenerUids: census({ 8788: [T1] }),
    });
    expect(d).toMatchObject({ port: 8788, reason: 'default-own', moved: false });
  });

  it("moves tenant 2 off tenant 1's :8788 to its uid-derived tenant port (the cap-p011 bug)", () => {
    const d = resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, {
      env: {},
      uid: T2,
      listenerUids: census({ 8788: [T1] }),
    });
    expect(d).toEqual({ port: 23800 + (T2 % 1000), reason: 'tenant-port', moved: true, foreignUids: [T1] });
  });

  it('gives different tenants different ports, and each tenant the same port every time', () => {
    const holders = census({ 8788: [999], 9071: [999] });
    const a = resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, { env: {}, uid: T1, listenerUids: holders });
    const b = resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, { env: {}, uid: T2, listenerUids: holders });
    const a2 = resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, { env: {}, uid: T1, listenerUids: holders });
    expect(a.port).not.toBe(b.port);
    expect(a2.port).toBe(a.port);
    // The two services' tenant ranges never overlap.
    const p = resolveTenantLoopbackPort(MCP_PROXY_TENANT_SERVICE, { env: {}, uid: T1, listenerUids: holders });
    expect(p.port).toBeGreaterThanOrEqual(24800);
    expect(p.port).not.toBe(a.port);
  });

  it('walks past a tenant port another uid holds, and re-adopts one this uid holds', () => {
    const own = 23800 + (T2 % 1000);
    const skipped = resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, {
      env: {},
      uid: T2,
      listenerUids: census({ 8788: [T1], [own]: [T1] }),
    });
    expect(skipped).toMatchObject({ port: own + 1, reason: 'tenant-port' });
    const readopted = resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, {
      env: {},
      uid: T2,
      listenerUids: census({ 8788: [T1], [own]: [T2] }),
    });
    expect(readopted.port).toBe(own);
  });

  it('wraps inside the range instead of leaving it', () => {
    const svc = { ...GATEWAY_TENANT_SERVICE, span: 3 };
    const uid = 2; // start = rangeBase + 2 (the last slot)
    const d = resolveTenantLoopbackPort(svc, {
      env: {},
      uid,
      listenerUids: census({ 8788: [T1], 23802: [T1] }),
    });
    expect(d.port).toBe(23800);
  });

  it('never moves an EXPLICIT port, but reports it as explicit-foreign when another uid owns it', () => {
    const d = resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, {
      env: { PAPERCUSP_GATEWAY_PORT: '8788' },
      uid: T2,
      listenerUids: census({ 8788: [T1] }),
    });
    expect(d).toEqual({ port: 8788, reason: 'explicit-foreign', moved: false, foreignUids: [T1] });
  });

  it('falls back to the configured port when ownership cannot be read (non-Linux) or the uid is unknown', () => {
    expect(
      resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, { env: {}, uid: T2, listenerUids: () => null }),
    ).toMatchObject({ port: 8788, reason: 'ownership-unknown', moved: false });
    expect(
      resolveTenantLoopbackPort(GATEWAY_TENANT_SERVICE, { env: {}, uid: null, listenerUids: census({ 8788: [T1] }) }),
    ).toMatchObject({ port: 8788, reason: 'ownership-unknown', moved: false });
  });

  it('reports no-tenant-port-free rather than adopting when the whole range is foreign', () => {
    const svc = { ...GATEWAY_TENANT_SERVICE, span: 2 };
    const d = resolveTenantLoopbackPort(svc, {
      env: {},
      uid: T2,
      listenerUids: census({ 8788: [T1], 23800: [T1], 23801: [T1] }),
    });
    expect(d).toMatchObject({ port: 8788, reason: 'no-tenant-port-free', moved: false });
  });
});

describe('pinTenantLoopbackPort(s)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('writes the moved port (and the proxy base URL agents read) into env, once', () => {
    const env: NodeJS.ProcessEnv = {};
    const holders = census({ 8788: [T1], 9071: [T1] });
    const [gw, proxy] = pinTenantLoopbackPorts({ env, uid: T2, listenerUids: holders });
    expect(gw.moved && proxy.moved).toBe(true);
    expect(env.PAPERCUSP_GATEWAY_PORT).toBe(String(gw.port));
    expect(env.PAPERCUSP_MCP_PROXY_PORT).toBe(String(proxy.port));
    expect(env.PAPERCUSP_MCP_PROXY_BASE).toBe(`http://127.0.0.1:${proxy.port}`);
    // Idempotent: the second pin sees the explicit, now-own port and changes nothing.
    const again = pinTenantLoopbackPorts({ env, uid: T2, listenerUids: census({ 8788: [T1], 9071: [T1] }) });
    expect(again.map((d) => d.reason)).toEqual(['explicit', 'explicit']);
    expect(env.PAPERCUSP_GATEWAY_PORT).toBe(String(gw.port));
  });

  it('never overwrites an operator-configured PAPERCUSP_MCP_PROXY_BASE', () => {
    const env: NodeJS.ProcessEnv = { PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:7777' };
    pinTenantLoopbackPort(MCP_PROXY_TENANT_SERVICE, { env, uid: T2, listenerUids: census({ 9071: [T1] }) });
    expect(env.PAPERCUSP_MCP_PROXY_BASE).toBe('http://127.0.0.1:7777');
  });

  it('leaves env untouched when the default is free or ours', () => {
    const env: NodeJS.ProcessEnv = {};
    pinTenantLoopbackPorts({ env, uid: T1, listenerUids: census({ 8788: [T1] }) });
    expect(env).toEqual({});
  });
});

describe('loopbackPortHeldByForeignUid', () => {
  it('is true only when the census proves another uid listens there', () => {
    expect(loopbackPortHeldByForeignUid(8788, { uid: T2, listenerUids: census({ 8788: [T1] }) })).toBe(true);
    expect(loopbackPortHeldByForeignUid(8788, { uid: T2, listenerUids: census({ 8788: [T1, T2] }) })).toBe(true);
    expect(loopbackPortHeldByForeignUid(8788, { uid: T1, listenerUids: census({ 8788: [T1] }) })).toBe(false);
    expect(loopbackPortHeldByForeignUid(8788, { uid: T1, listenerUids: census({}) })).toBe(false);
    expect(loopbackPortHeldByForeignUid(8788, { uid: T1, listenerUids: () => null })).toBe(false);
    expect(loopbackPortHeldByForeignUid(8788, { uid: null, listenerUids: census({ 8788: [T1] }) })).toBe(false);
  });
});

describe('ensureGatewaySidecar on a shared host (WI-10005481)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    _resetGatewaySidecarStateForTests();
    delete process.env.PAPERCUSP_GATEWAY_PORT;
    delete process.env.PAPERCUSP_GATEWAY_SUPERVISE;
    process.env.PAPERCUSP_GATEWAY_REPROBE_SEC = '0'; // no timer to leak
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await stopGatewaySidecar();
    _resetGatewaySidecarStateForTests();
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("tenant 2 SPAWNS its own gateway on its tenant port instead of adopting tenant 1's :8788", async () => {
    const holders = census({ 8788: [T1] });
    const spawnGatewayChild = vi.fn(async () => {});
    const isListening = vi.fn(async () => false);
    const outcome = await ensureGatewaySidecar({
      pinPort: () => pinTenantLoopbackPort(GATEWAY_TENANT_SERVICE, { uid: T2, listenerUids: holders }),
      heldByForeignUid: (p) => loopbackPortHeldByForeignUid(p, { uid: T2, listenerUids: holders }),
      isListening,
      spawnGatewayChild,
    });
    const tenantPort = 23800 + (T2 % 1000);
    expect(outcome).toBe('spawned');
    expect(spawnGatewayChild).toHaveBeenCalledWith(tenantPort);
    expect(isListening).toHaveBeenCalledWith(tenantPort);
    // Agents spawned afterwards read this env var (spawn-env gatewayPort()).
    expect(process.env.PAPERCUSP_GATEWAY_PORT).toBe(String(tenantPort));
    expect(_gatewaySidecarStateForTests().adoptedExternal).toBe(false);
  });

  it('REFUSES (never adopts) a listener another uid holds on an explicitly pinned port', async () => {
    process.env.PAPERCUSP_GATEWAY_PORT = '8788';
    const holders = census({ 8788: [T1] });
    const spawnGatewayChild = vi.fn(async () => {});
    const isListening = vi.fn(async () => true);
    const outcome = await ensureGatewaySidecar({
      pinPort: () => pinTenantLoopbackPort(GATEWAY_TENANT_SERVICE, { uid: T2, listenerUids: holders }),
      heldByForeignUid: (p) => loopbackPortHeldByForeignUid(p, { uid: T2, listenerUids: holders }),
      isListening,
      spawnGatewayChild,
    });
    expect(outcome).toBe('refused-foreign');
    expect(spawnGatewayChild).not.toHaveBeenCalled();
    expect(isListening).not.toHaveBeenCalled();
    expect(_gatewaySidecarStateForTests().adoptedExternal).toBe(false);
  });

  it('still adopts a listener THIS uid owns (the dev-box systemd gateway)', async () => {
    const holders = census({ 8788: [T1] });
    const outcome = await ensureGatewaySidecar({
      pinPort: () => pinTenantLoopbackPort(GATEWAY_TENANT_SERVICE, { uid: T1, listenerUids: holders }),
      heldByForeignUid: (p) => loopbackPortHeldByForeignUid(p, { uid: T1, listenerUids: holders }),
      isListening: async () => true,
      spawnGatewayChild: vi.fn(async () => {}),
    });
    expect(outcome).toBe('adopted-external');
    expect(process.env.PAPERCUSP_GATEWAY_PORT).toBeUndefined();
  });
});
