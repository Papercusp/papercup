/**
 * pot:create handler — the P-007b identity guard (watchdog-and-exposed-systems-
 * improvement-2026-06-18). An MCP client with no resolvable session identity made
 * resolveAgentIdentity THROW an opaque "missing uiClientId" that surfaced as a raw
 * tool error; the tool now CATCHES it and returns a structured `identity_unresolved`
 * error BEFORE provisioning anything. (createPotHarness itself round-trips in
 * ./_create.test.ts; this pins the guard + that the early return provisions nothing.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createPotHarness = vi.fn();
const resolvePot = vi.fn();
// Mock the heavy provisioning seams so importing the tool stays light AND so the
// early-return assertion (nothing provisioned) is observable.
vi.mock('./_create', () => ({ createPotHarness: (...a: unknown[]) => createPotHarness(...a) }));
vi.mock('./_resolve', () => ({ resolvePot: (...a: unknown[]) => resolvePot(...a) }));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-active',
  resolveConcreteWorkspaceId: (...c: Array<string | null | undefined>) =>
    c.find((x): x is string => typeof x === 'string' && x.trim() !== '' && x.trim() !== '*') ?? 'ws-active',
}));

import potCreateTool from './create';

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
const tool = potCreateTool as unknown as Tool;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('pot:create identity guard (P-007b)', () => {
  it('returns a structured identity_unresolved error (not an opaque throw) for a ctx with no identity', async () => {
    const res = parse(await tool.handler({ slug: 'test-pot' }, {} as never));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('identity_unresolved');
    expect(String(res.message)).toMatch(/session identity/i);
    // The raw resolveAgentIdentity message is preserved as `detail` for diagnosis.
    expect(String(res.detail)).toMatch(/identity/i);
  });

  it('provisions NOTHING when identity is unresolved (fails before createPotHarness)', async () => {
    await tool.handler({ slug: 'test-pot' }, {} as never);
    expect(createPotHarness).not.toHaveBeenCalled();
    expect(resolvePot).not.toHaveBeenCalled();
  });
});
