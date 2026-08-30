import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GATEWAY_LANE_KERNEL_CONFORMANCE_SCHEMA_VERSION,
  GATEWAY_STRANGLER_SURFACE_FILE,
  LANES_ADMITTED_VIA_LEGACY_BRIDGE,
  LEGACY_STRANGLER_SURFACE_BASELINE,
  countExecuteLegacyLaneTaskCallSites,
  countLegacyEntryExecutorIndexSites,
  gatewayStranglerScaffoldingIsDeletable,
  scanGatewayLaneKernelConformance,
  type GatewayLaneId,
} from './lane-kernel-conformance';
import { makeGatewayLaneRegistry } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';

const account = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-token` });
const pool = (id: string): AccountPool => {
  const active = account(id);
  return {
    active: () => active,
    onExhausted: () => null,
    select: (accountId) => (accountId === id ? active : null),
  };
};

const registry = () =>
  makeGatewayLaneRegistry({
    claudePool: pool('claude-a'),
    codexPool: pool('codex-a'),
    codexCliAccountCount: () => 1,
    anthropicUpstreamBase: 'https://anthropic.test',
    openaiUpstreamBase: 'https://openai.test',
  });

/** The real gateway source, read from the repository rather than a fixture copy. */
const gatewaySource = () => {
  // this file lives at packages/operator-core/lib/inference-gateway/
  const repoRoot = join(__dirname, '..', '..', '..', '..');
  return {
    path: GATEWAY_STRANGLER_SURFACE_FILE,
    source: readFileSync(join(repoRoot, GATEWAY_STRANGLER_SURFACE_FILE), 'utf8'),
  };
};

describe('gateway lane kernel conformance (P-008 / D-021)', () => {
  it('is clean against the live registry and the live gateway source', () => {
    expect(GATEWAY_LANE_KERNEL_CONFORMANCE_SCHEMA_VERSION).toBe('gateway-lane-kernel-conformance-v1');
    expect(scanGatewayLaneKernelConformance(registry(), [gatewaySource()])).toEqual([]);
  });

  it('records the CURRENT truth: every registered lane is still bridge-admitted', () => {
    // D-021: this is deliberately not an empty allowlist. `executeLegacyLaneTask` is the
    // gateway's only admission crossing, so no lane has been re-homed yet. When this list
    // reaches zero the scaffolding is deletable — that is the burn-down, and it is the
    // assertion that will change as re-homing lands.
    const lanes = registry();
    expect([...LANES_ADMITTED_VIA_LEGACY_BRIDGE].sort()).toEqual(
      Object.values(lanes)
        .map((lane) => lane.id)
        .sort(),
    );
    expect(gatewayStranglerScaffoldingIsDeletable(lanes)).toBe(false);
  });

  it('the measured baseline matches the live gateway source exactly', () => {
    // A baseline ABOVE the observed count is slack the ratchet would silently permit, so
    // pin equality here rather than the >= the guard itself enforces.
    const { source } = gatewaySource();
    expect(countExecuteLegacyLaneTaskCallSites(source)).toBe(
      LEGACY_STRANGLER_SURFACE_BASELINE.executeLegacyLaneTaskCallSites,
    );
    expect(countLegacyEntryExecutorIndexSites(source)).toBe(
      LEGACY_STRANGLER_SURFACE_BASELINE.legacyEntryExecutorIndexSites,
    );
  });

  // ---- falsifiability controls: each drives the REAL scanner with a deliberately
  // non-conformant input, so the guard is proved to fail rather than assumed to. ----

  it('DETECTS a newly registered lane that takes the legacy bridge (the regrowth it exists to stop)', () => {
    const lanes = registry();
    const findings = scanGatewayLaneKernelConformance(lanes, [], {
      // simulate a lane registered after the allowlist was frozen
      allowlist: ['anthropic-messages', 'openai-responses'],
    });
    expect(findings).toContain('lane-admitted-outside-kernel:local-openai-chat:proxyLocal');
  });

  it('DETECTS a stale allowlist entry, so the ratchet cannot stop shrinking', () => {
    const findings = scanGatewayLaneKernelConformance(registry(), [], {
      allowlist: [...LANES_ADMITTED_VIA_LEGACY_BRIDGE, 'a-lane-that-was-re-homed' as GatewayLaneId],
    });
    expect(findings).toContain('allowlist-entry-retired:a-lane-that-was-re-homed');
  });

  it('DETECTS a grown strangler surface, reporting observed vs permitted', () => {
    const synthetic = {
      path: GATEWAY_STRANGLER_SURFACE_FILE,
      source: [
        'void executeLegacyLaneTask({ lane: a });',
        'void executeLegacyLaneTask({ lane: b });',
        'void executeLegacyLaneTask({ lane: c });',
        'void executeLegacyLaneTask({ lane: d });',
      ].join('\n'),
    };
    const findings = scanGatewayLaneKernelConformance(registry(), [synthetic]);
    expect(findings).toContain('strangler-surface-grew:executeLegacyLaneTaskCallSites:4:3');
  });

  it('does not mistake the declaration or comment prose for a call site', () => {
    const source = [
      '  // executeLegacyLaneTask( is named here in prose only',
      '   * executeLegacyLaneTask( also appears in a block comment',
      '  async function executeLegacyLaneTask<TResult>(opts: {',
      '  void executeLegacyLaneTask({',
    ].join('\n');
    expect(countExecuteLegacyLaneTaskCallSites(source)).toBe(1);
  });

  it('a shrinking surface is conformant — the ratchet is one-directional', () => {
    const shrunk = {
      path: GATEWAY_STRANGLER_SURFACE_FILE,
      source: 'void executeLegacyLaneTask({ lane: a });\nlegacyGatewayEntryExecutors[x](req, res, url);',
    };
    expect(
      scanGatewayLaneKernelConformance(registry(), [shrunk]).filter((f) =>
        f.startsWith('strangler-surface-grew:'),
      ),
    ).toEqual([]);
  });

  it('reports the END STATE as deletable once no lane declares a legacy entry executor', () => {
    const lanes = registry();
    const reHomed = Object.fromEntries(
      Object.entries(lanes).map(([key, lane]) => [key, { ...lane, legacyEntryExecutor: undefined }]),
    ) as unknown as ReturnType<typeof registry>;
    expect(gatewayStranglerScaffoldingIsDeletable(reHomed)).toBe(true);
    // and with the allowlist emptied alongside it, the guard is clean
    expect(scanGatewayLaneKernelConformance(reHomed, [], { allowlist: [] })).toEqual([]);
  });
});
