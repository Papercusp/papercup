import { describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({
  searchWorkItems: vi.fn(),
}));

import search from './search';

describe('work_items:search transaction scope', () => {
  it('opts out of the ambient workspace transaction because search owns its DB scopes', () => {
    expect((search as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});
