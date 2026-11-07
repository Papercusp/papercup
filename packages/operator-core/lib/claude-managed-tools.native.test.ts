/** Installed Claude request-surface proof; loopback fixtures never forward inference. */
import { describe, expect, it } from 'vitest';
import { nativeToolInventory } from '../../../libs/papercusp/packages/orchestrator/src/managed-capability-client-inventory';
import { captureNativeMcp } from './memory/fixtures/native-mcp-export';

declare module 'vitest' {
  interface TaskMeta { nativeToolSurface?: unknown; }
}
const canary = 'managed_surface_canary';
async function captureSurface(deny: string[]) {
  const result = await captureNativeMcp('claude', [{ name: canary, description: 'Local managed tool canary.' }], undefined, deny);
  return { version: result.clientVersion, names: result.descriptors.map(tool => tool.name) };
}

describe('Claude managed replacement installed-client census', () => {
  it('removes denied native execution tools while retaining the managed MCP surface', async ({ task }) => {
    const denied = ['Bash', 'Read', 'Edit', 'Write'];
    const baseline = await captureSurface([]);
    const restricted = await captureSurface(denied);
    const inventory = nativeToolInventory({ client: 'claude', clientVersion: baseline.version,
      nativeNames: [...baseline.names, ...restricted.names], managedNames: [canary] });
    task.meta.nativeToolSurface = { baseline, restricted, inventory };
    expect(inventory.rows.every(row => row.gap === null || row.gap === 'client-version-drift')).toBe(true);
    for (const name of denied) {
      expect(baseline.names).toContain(name);
      expect(restricted.names).not.toContain(name);
    }
  }, 60_000);
});
