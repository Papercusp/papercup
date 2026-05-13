/**
 * Integration tests for the plugin capability-grant store.
 * Soft-skipped when embedded-pg isn't reachable.
 *
 * Step G (Tier-2 follow-up arc) — scoped narrowly to the grant
 * mechanics (the unique-to-plugins surface that doesn't require WASM
 * scaffolding). Install/enable/disable lifecycle E2E deferred per
 * apps/operator/docs/plans/deferred-followups-2026-05-14.md.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

let pgReachable = false;
let mod: typeof import('./plugin-grants') | null = null;
type ClientLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; end: () => Promise<void> };
let pgClient: ClientLike | null = null;

const TEST_PLUGIN = `vitest-plugin-${randomBytes(3).toString('hex')}`;
const TEST_HARNESS = `vitest-harness-${randomBytes(3).toString('hex')}`;
const TEST_VERSION = '0.0.1';

beforeAll(async () => {
  try {
    const { pgClientFields } = await import('./memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    await c.query("SELECT 1 FROM harness_shared.plugin_capability_grants LIMIT 1");
    pgClient = c as unknown as ClientLike;
    pgReachable = true;
  } catch {
    pgReachable = false;
  }
  if (pgReachable) {
    mod = await import('./plugin-grants');
    // Warm-up.
    try {
      await mod.getGrantsForPluginInHarness('__warmup__', TEST_VERSION, '', { skipLegacy: true });
    } catch { /* ok */ }
  }
});

afterEach(async () => {
  if (pgClient) {
    await pgClient.query(
      `DELETE FROM harness_shared.plugin_capability_grants WHERE plugin_name LIKE 'vitest-plugin-%'`,
    );
  }
});

const itPg = (name: string, fn: () => Promise<void> | void) => {
  it(name, async () => {
    if (!pgReachable || !mod) return;
    await fn();
  });
};

describe('plugin capability grants', () => {
  itPg('returns empty when no grants exist', async () => {
    const grants = await mod!.getGrantsForPluginInHarness(
      TEST_PLUGIN, TEST_VERSION, TEST_HARNESS, { skipLegacy: true },
    );
    expect(grants).toEqual([]);
  });

  itPg('grantCapabilities persists then getGrantsForPluginInHarness returns them', async () => {
    await mod!.grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['system:read', 'fs:list'],
      grantedBy: 'vitest',
    });
    const grants = await mod!.getGrantsForPluginInHarness(
      TEST_PLUGIN, TEST_VERSION, TEST_HARNESS, { skipLegacy: true },
    );
    expect(grants.sort()).toEqual(['fs:list', 'system:read']);
  });

  itPg('global ("") harness grants apply across all harnesses', async () => {
    await mod!.grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: '',
      capabilities: ['log:write'],
      grantedBy: 'vitest',
    });
    // Query for a SPECIFIC harness — should still include the global grant.
    const grants = await mod!.getGrantsForPluginInHarness(
      TEST_PLUGIN, TEST_VERSION, 'random-harness-name', { skipLegacy: true },
    );
    expect(grants).toContain('log:write');
  });

  itPg('grants scoped to one harness do not leak to another', async () => {
    await mod!.grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: 'harness-A',
      capabilities: ['secret:read'],
    });
    const inA = await mod!.getGrantsForPluginInHarness(
      TEST_PLUGIN, TEST_VERSION, 'harness-A', { skipLegacy: true },
    );
    const inB = await mod!.getGrantsForPluginInHarness(
      TEST_PLUGIN, TEST_VERSION, 'harness-B', { skipLegacy: true },
    );
    expect(inA).toContain('secret:read');
    expect(inB).not.toContain('secret:read');
  });

  itPg('grants are version-pinned: a different version sees an empty grant set', async () => {
    await mod!.grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['cap:a'],
    });
    const v2Grants = await mod!.getGrantsForPluginInHarness(
      TEST_PLUGIN, '99.99.99', TEST_HARNESS, { skipLegacy: true },
    );
    expect(v2Grants).not.toContain('cap:a');
  });

  itPg('revokeCapabilities removes the grant', async () => {
    await mod!.grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['cap:x', 'cap:y'],
    });
    await mod!.revokeCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['cap:x'],
    });
    const grants = await mod!.getGrantsForPluginInHarness(
      TEST_PLUGIN, TEST_VERSION, TEST_HARNESS, { skipLegacy: true },
    );
    expect(grants).not.toContain('cap:x');
    expect(grants).toContain('cap:y');
  });

  itPg('re-granting an existing tuple is idempotent (no error)', async () => {
    await mod!.grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['cap:z'],
    });
    // Re-grant the same tuple — should be a silent no-op.
    await expect(mod!.grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['cap:z'],
    })).resolves.toBeUndefined();
    const grants = await mod!.getGrantsForPluginInHarness(
      TEST_PLUGIN, TEST_VERSION, TEST_HARNESS, { skipLegacy: true },
    );
    expect(grants).toEqual(['cap:z']);
  });
});
