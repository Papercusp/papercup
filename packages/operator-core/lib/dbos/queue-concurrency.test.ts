/** DBOS queues must not carry a duplicate local capacity ceiling. */
import { describe, expect, it } from 'vitest';
import { queueConcurrency } from './queue-concurrency';

describe('queueConcurrency compatibility seam', () => {
  it('returns no local cap for every legacy queue ceiling', () => {
    for (const ceiling of [1, 2, 4, 8, 32, 256]) {
      expect(queueConcurrency(ceiling)).toBeUndefined();
    }
  });
});
