import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));

vi.mock('../../events/await/lost-wake-detect', () => ({
  findLostWakes: vi.fn(),
}));

import lostWakeCheck from './lost-wake-check';

describe('events:lost-wake-check — workspace-global scope is explicit', () => {
  it('documents that harness/workspace are not JSON filters', () => {
    const shape = (lostWakeCheck.args as unknown as {
      shape: Record<string, unknown>;
    }).shape;

    expect(shape).not.toHaveProperty('harness');
    expect(shape).not.toHaveProperty('workspace');
    expect(lostWakeCheck.description).toMatch(/workspace-global/i);
    expect(lostWakeCheck.description).toMatch(/do not pass `harness` or `workspace`/i);
  });

  it('keeps the declared diagnostic arguments available', () => {
    expect(lostWakeCheck.args.safeParse({
      sinceDays: 1,
      minSettled: 5,
      degenerateRatePct: 10,
    }).success).toBe(true);
  });
});
