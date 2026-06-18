/**
 * hive:create handler — the P-007b identity guard (watchdog-and-exposed-systems-
 * improvement-2026-06-18). An MCP client with no resolvable session identity made
 * resolveAgentIdentity THROW an opaque "missing uiClientId" that surfaced as a raw
 * tool error; the tool now CATCHES it and returns a structured `identity_unresolved`
 * error BEFORE provisioning anything. (createHiveHarness itself round-trips in
 * ./_create.test.ts; this pins the guard + that the early return provisions nothing.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createHiveHarness = vi.fn();
const resolveHive = vi.fn();
// Mock the heavy provisioning seams so importing the tool stays light AND so the
// early-return assertion (nothing provisioned) is observable.
vi.mock('./_create', () => ({ createHiveHarness: (...a: unknown[]) => createHiveHarness(...a) }));
vi.mock('./_resolve', () => ({ resolveHive: (...a: unknown[]) => resolveHive(...a) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));

import hiveCreateTool from './create';

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
const tool = hiveCreateTool as unknown as Tool;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('hive:create identity guard (P-007b)', () => {
  it('returns a structured identity_unresolved error (not an opaque throw) for a ctx with no identity', async () => {
    const res = parse(await tool.handler({ slug: 'test-hive' }, {} as never));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('identity_unresolved');
    expect(String(res.message)).toMatch(/session identity/i);
    // The raw resolveAgentIdentity message is preserved as `detail` for diagnosis.
    expect(String(res.detail)).toMatch(/identity/i);
  });

  it('provisions NOTHING when identity is unresolved (fails before createHiveHarness)', async () => {
    await tool.handler({ slug: 'test-hive' }, {} as never);
    expect(createHiveHarness).not.toHaveBeenCalled();
    expect(resolveHive).not.toHaveBeenCalled();
  });
});
