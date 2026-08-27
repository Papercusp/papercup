/**
 * Regression guard for EI-21607945572265622.
 *
 * Lightweight tests often mock the agent-mcp barrel with only the helper they
 * exercise. The capability policy must still load when that mock omits the
 * barrel's AGENT_ROLES export; the registry is sourced from its dedicated leaf.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  testingFullAccess: () => false,
}));

describe('capability policy import graph', () => {
  it('loads with an incomplete agent-mcp barrel mock', async () => {
    const policy = await import('./policy');

    expect(policy.FLEET_ENVELOPE_ROLES).toBeInstanceOf(Set);
    expect(policy.FLEET_ENVELOPE_ROLES.has('worker')).toBe(true);
    expect(policy.FLEET_ENVELOPE_ROLES.has('operator')).toBe(false);
  });
});
