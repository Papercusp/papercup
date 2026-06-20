import { describe, it, expect } from 'vitest';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import './run'; // side-effect: registers code:run

/**
 * B-CX-2A: the code:run tool registers into the projected registry, is marked write-effect
 * (so it's itself dry-run-gateable), and is role-gated to the SU roles.
 */
describe('code:run registration (B-CX-2A)', () => {
  it('registers code:run as a write-effect, role-gated tool', () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:run');
    expect(tool).toBeDefined();
    expect(tool?.effect).toBe('write');
    expect((tool?.agentRoles?.length ?? 0)).toBeGreaterThan(0);
  });
});
