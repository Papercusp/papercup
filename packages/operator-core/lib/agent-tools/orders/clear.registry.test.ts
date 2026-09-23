import { beforeAll, describe, expect, it } from 'vitest';
import { listAllProjectedTools } from '@papercusp/agent-mcp';

beforeAll(async () => {
  await import('../index');
});

describe('orders:clear registration', () => {
  it('is present in the projected catalog used by code:run', () => {
    const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'orders:clear');

    expect(tool).toBeDefined();
  });
});
