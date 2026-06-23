/**
 * EI-2048: the shared system-principal provisioning helper. Asserts the cap sets
 * are the code-defined source of truth (operator includes memory + locks — the
 * 2026-06-20 grant) and that both the route and the boot auto-heal drive the SAME
 * forceless loop (additive reconcile, no bearer rotation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ name: string; capabilities: string[]; force: boolean | undefined }> = [];
vi.mock('@papercusp/agent-mcp/provisioning', () => ({
  provisionSystemPrincipal: vi.fn(async (args: { name: string; capabilities: string[]; force?: boolean }) => {
    calls.push({ name: args.name, capabilities: args.capabilities, force: args.force });
    // Simulate an existing-but-drifted row reconciled in place (no rotation).
    return { workspaceId: 'ws', name: args.name, configPath: null, rotated: false, reconciled: true };
  }),
}));

import { provisionSystemPrincipals, OPERATOR_CAPS, ORACLE_CAPS } from './ensure-system-principals';

beforeEach(() => {
  calls.length = 0;
});

describe('ensure-system-principals (EI-2048)', () => {
  it('operator caps include the 2026-06-20 memory + locks grant; oracle does not', () => {
    expect(OPERATOR_CAPS).toContain('memory:read');
    expect(OPERATOR_CAPS).toContain('memory:write');
    expect(OPERATOR_CAPS).toContain('locks:read');
    expect(OPERATOR_CAPS).toContain('locks:write');
    // oracle is read-mostly survey — no memory/locks write.
    expect(ORACLE_CAPS as readonly string[]).not.toContain('memory:write');
    expect(ORACLE_CAPS as readonly string[]).not.toContain('locks:write');
    // operator ⊇ oracle (it spreads ORACLE_CAPS).
    for (const c of ORACLE_CAPS) expect(OPERATOR_CAPS as readonly string[]).toContain(c);
  });

  it('provisions oracle + operator with their cap sets, forceless by default', async () => {
    const out = await provisionSystemPrincipals({ workspaceId: 'ws', papercuspRoot: '/root' });
    expect(calls.map((c) => c.name)).toEqual(['oracle', 'operator']);
    expect(calls.every((c) => c.force === undefined)).toBe(true); // forceless → no bearer rotation
    expect(calls[1].capabilities).toContain('memory:write'); // operator carries the grant
    expect(out.map((p) => p.name)).toEqual(['oracle', 'operator']);
    expect(out.every((p) => p.reconciled)).toBe(true);
  });

  it('threads force:true through when an explicit rotation is requested', async () => {
    await provisionSystemPrincipals({ workspaceId: 'ws', papercuspRoot: '/root', force: true });
    expect(calls.every((c) => c.force === true)).toBe(true);
  });
});
