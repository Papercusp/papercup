import { describe, expect, it } from 'vitest';
import {
  COORD_PROGRAM_QUEUE_MIN_POLL_MS,
  coordProgramQueue,
} from './coord-program-workflow';

// P-013 D-025: the coord-program queue must not fall back to DBOS's 1000 ms
// default poll floor, which delayed every program's first step by U(0,1 s).
describe('coord-program queue poll floor', () => {
  it('configures the queue with the pinned floor', () => {
    expect(coordProgramQueue.minPollingIntervalMs).toBe(COORD_PROGRAM_QUEUE_MIN_POLL_MS);
  });

  it('keeps the floor well under the DBOS 1000 ms default', () => {
    expect(COORD_PROGRAM_QUEUE_MIN_POLL_MS).toBeGreaterThan(0);
    expect(COORD_PROGRAM_QUEUE_MIN_POLL_MS).toBeLessThanOrEqual(100);
  });
});
