import { describe, expect, it } from 'vitest';

import {
  LEARNING_MODEL_EFFORT,
  LEARNING_MODEL_ID,
  LEARNING_MODEL_SPEC,
  isCanonicalLearningModel,
} from './model-policy';

describe('canonical learning model policy', () => {
  it('preserves the exact Sol xhigh owner directive without a family alias', () => {
    expect(LEARNING_MODEL_ID).toBe('gpt-5.6-sol');
    expect(LEARNING_MODEL_EFFORT).toBe('xhigh');
    expect(LEARNING_MODEL_SPEC).toBe('gpt-5.6-sol:xhigh');
    expect(isCanonicalLearningModel(LEARNING_MODEL_SPEC)).toBe(true);
    expect(isCanonicalLearningModel('gpt-5.6:xhigh')).toBe(false);
    expect(isCanonicalLearningModel('gpt-5.6-sol:high')).toBe(false);
  });
});
