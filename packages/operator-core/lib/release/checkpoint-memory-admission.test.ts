import { describe, expect, it } from 'vitest';

import { admitCheckpointMemory } from './checkpoint-memory-admission';

describe('checkpoint launch without an aggregate RAM cap', () => {
  it.each([124, 125, 126, 1_000_000])(
    'admits a %i GiB scope across and beyond the former 125 GiB boundary',
    (requestG) => {
      expect(admitCheckpointMemory({ requestG, key: '/pot/large' })).toMatchObject({
        admit: true,
        reason: 'admitted-unbounded',
        requestG,
        budgetG: null,
      });
    },
  );

  it('admits a large run after many small roots without reservations or starvation', () => {
    for (let round = 0; round < 3; round++) {
      for (let root = 0; root < 20; root++) {
        expect(admitCheckpointMemory({ requestG: 8, key: `/pot/${root}` }).admit).toBe(true);
      }
      expect(admitCheckpointMemory({ requestG: 40, key: '/pot/papercusp' }).admit).toBe(true);
    }
  });

  it.each(['0', '1', undefined])(
    'cannot restore a RAM admission cap with legacy admission setting %s',
    (setting) => {
      expect(admitCheckpointMemory({
        requestG: 40,
        key: '/pot/papercusp',
        env: {
          PAPERCUSP_CHECKPOINT_MEMORY_ADMISSION: setting,
          PAPERCUSP_CHECKPOINT_MEMORY_BUDGET_G: '1',
        },
      }).admit).toBe(true);
    },
  );

  it('does not read legacy budget settings or a root key during admission', () => {
    const opts = {
      requestG: 40,
      get env(): NodeJS.ProcessEnv { throw new Error('legacy budget must not be consulted'); },
      get key(): string { throw new Error('reservation identity must not be consulted'); },
    };
    expect(admitCheckpointMemory(opts).admit).toBe(true);
  });

  it('reports the absence of a budget and measurement without fabricated zero usage', () => {
    expect(admitCheckpointMemory({ requestG: 40 })).toMatchObject({
      committedG: null,
      budgetG: null,
      scopes: null,
      unbounded: null,
    });
  });
});
