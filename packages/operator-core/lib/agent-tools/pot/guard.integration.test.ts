/**
 * pot lifecycle tools are ROOT-ONLY (hive-tool-namespace-2026-06-08 P-010,
 * D-002). pot:create / pot:dissolve / pot:update must refuse a parented cup
 * (a fleet-spawn caller — uiClientId, no principal/superuser) up front, before
 * any side effect. The assertNotNestedPot guard in fireLaunchBlueprint is the
 * runtime backstop; this asserts the tool-level refusal (hives are peers, never
 * nested — a cup spins a kind:harness subharness instead).
 *
 * PG-free: the guard returns before any registry/PG access.
 */
import { describe, it, expect } from 'vitest';

/** A cup / fleet-spawn ctx: a VERIFIED signed spawn (sigVerifiedSpawn — the MCP
 *  handler checked the URL HMAC, EI-318) carrying its `s-…` client id, no
 *  principal / superuser / power-user. resolveAgentIdentity attributes this to
 *  `source: 'fleet-spawn'`; the pot tools then refuse it as root-only. */
const CUP_CTX = { uiClientId: 's-cup-1', sigVerifiedSpawn: true, workspaceId: 'default' } as never;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);
type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };

describe('pot lifecycle tools refuse a cup / fleet-spawn caller (root-only)', () => {
  it('pot:create refuses', async () => {
    const tool = (await import('./create')).default as unknown as Tool;
    const res = parse(await tool.handler({ slug: 'x' }, CUP_CTX));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('hive_create_root_only');
  });

  it('pot:dissolve refuses (before the confirm gate)', async () => {
    const tool = (await import('./dissolve')).default as unknown as Tool;
    const res = parse(await tool.handler({ slug: 'x', confirm: true }, CUP_CTX));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('hive_dissolve_root_only');
  });

  it('pot:update refuses', async () => {
    const tool = (await import('./update')).default as unknown as Tool;
    const res = parse(await tool.handler({ slug: 'x', configOverrides: { a: 1 } }, CUP_CTX));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('hive_update_root_only');
  });
});
