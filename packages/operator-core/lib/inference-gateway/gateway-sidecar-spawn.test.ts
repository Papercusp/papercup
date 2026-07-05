/**
 * Tests for the cross-platform inference-gateway supervisor (P-006,
 * cross-platform-hardening-and-agent-ergonomics-2026-07-05 / WI-3059).
 *
 * Covers the PURE seams + the two side-effect-free ensureGatewaySidecar outcomes
 * ('disabled' kill-switch, 'adopted-external' port adoption). The 'spawned' path
 * forks a real child process, so it is exercised by the Mac-VM / desktop E2E smoke,
 * not unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  buildGatewaySpawnPlan,
  gatewayRespawnBackoffMs,
  gatewaySupervisorPort,
  isGatewayListening,
  ensureGatewaySidecar,
  GATEWAY_MAX_RESPAWN_ATTEMPTS,
  GATEWAY_RESPAWN_WINDOW_MS,
  _resetGatewaySidecarStateForTests,
  _gatewaySidecarStateForTests,
} from './gateway-sidecar-spawn';
import { DEFAULT_GATEWAY_PORT } from './launch';

function listenEphemeral(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const SAVED_ENV_KEYS = ['PAPERCUSP_GATEWAY_PORT', 'PAPERCUSP_GATEWAY_SUPERVISE'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(SAVED_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of SAVED_ENV_KEYS) delete process.env[k];
  _resetGatewaySidecarStateForTests();
});

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] == null) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _resetGatewaySidecarStateForTests();
});

describe('gatewayRespawnBackoffMs', () => {
  it('doubles from 1s and caps at 30s (mirrors substrate-sidecar-spawn)', () => {
    expect(gatewayRespawnBackoffMs(1)).toBe(1_000);
    expect(gatewayRespawnBackoffMs(2)).toBe(2_000);
    expect(gatewayRespawnBackoffMs(3)).toBe(4_000);
    expect(gatewayRespawnBackoffMs(4)).toBe(8_000);
    expect(gatewayRespawnBackoffMs(5)).toBe(16_000);
    expect(gatewayRespawnBackoffMs(6)).toBe(30_000); // 32s uncapped → capped
    expect(gatewayRespawnBackoffMs(10)).toBe(30_000);
  });

  it('circuit-breaker constants stay in lock-step with the sibling spawners', () => {
    expect(GATEWAY_MAX_RESPAWN_ATTEMPTS).toBe(5);
    expect(GATEWAY_RESPAWN_WINDOW_MS).toBe(5 * 60_000);
  });
});

describe('gatewaySupervisorPort', () => {
  it('defaults to DEFAULT_GATEWAY_PORT and honors the env override', () => {
    expect(gatewaySupervisorPort()).toBe(DEFAULT_GATEWAY_PORT);
    process.env.PAPERCUSP_GATEWAY_PORT = '9911';
    expect(gatewaySupervisorPort()).toBe(9911);
  });
});

describe('buildGatewaySpawnPlan', () => {
  it('dev (real .ts on disk) → `npx tsx <sibling>/bin.ts`', () => {
    const plan = buildGatewaySpawnPlan({
      selfPath: '/repo/packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts',
      execPath: '/usr/bin/node',
      moduleDirOverride: '/repo/packages/operator-core/lib/inference-gateway',
    });
    expect(plan.mode).toBe('dev-tsx');
    expect(plan.cmd).toBe('npx');
    expect(plan.args).toEqual(['tsx', '/repo/packages/operator-core/lib/inference-gateway/bin.ts']);
    expect(plan.env).toEqual({}); // divert var must NOT leak into the dev child
  });

  it('packaged (bundled serve.mjs) → re-exec self under the bundled node with the divert env', () => {
    const plan = buildGatewaySpawnPlan({
      selfPath: '/opt/Papercup/resources/serve.mjs',
      execPath: '/opt/Papercup/resources/node',
      moduleDirOverride: '/opt/Papercup/resources',
    });
    expect(plan.mode).toBe('bundled-reexec');
    expect(plan.cmd).toBe('/opt/Papercup/resources/node');
    expect(plan.args).toEqual(['/opt/Papercup/resources/serve.mjs']);
    expect(plan.env).toEqual({ PAPERCUSP_GATEWAY_SIDECAR_MODE: '1' });
  });
});

describe('isGatewayListening', () => {
  it('true against a live listener, false once it closes (and never throws)', async () => {
    const { server, port } = await listenEphemeral();
    try {
      await expect(isGatewayListening(port)).resolves.toBe(true);
    } finally {
      await closeServer(server);
    }
    // Same port, now closed → refused → false (not a throw).
    await expect(isGatewayListening(port, 1_000)).resolves.toBe(false);
  });
});

describe('ensureGatewaySidecar', () => {
  it("kill-switch PAPERCUSP_GATEWAY_SUPERVISE=0 → 'disabled' (no probe, no spawn)", async () => {
    process.env.PAPERCUSP_GATEWAY_SUPERVISE = '0';
    await expect(ensureGatewaySidecar()).resolves.toBe('disabled');
    expect(_gatewaySidecarStateForTests()).toMatchObject({ running: false, adoptedExternal: false });
  });

  it("adopts an externally-owned port (systemd on the dev box) → 'adopted-external'", async () => {
    const { server, port } = await listenEphemeral();
    process.env.PAPERCUSP_GATEWAY_PORT = String(port);
    try {
      await expect(ensureGatewaySidecar()).resolves.toBe('adopted-external');
      expect(_gatewaySidecarStateForTests()).toMatchObject({ running: false, adoptedExternal: true });
    } finally {
      await closeServer(server);
    }
  });
});
