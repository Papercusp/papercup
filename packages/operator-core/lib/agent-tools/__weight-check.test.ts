import { describe, it } from 'vitest';
import '../agent-tools/index';
import { namedToolWeights } from './tool-guidance-budget';

describe('weight check', () => {
  it('prints fleet:assignments weight', () => {
    const w = namedToolWeights().find((t) => t.name === 'fleet:assignments');
    console.log('WEIGHT', JSON.stringify(w));
  });
});
