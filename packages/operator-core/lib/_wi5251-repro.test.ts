import { describe, it, expect } from 'vitest';

describe('sanity: does fail-on-console actually fire', () => {
  it('an unexpected console.warn should fail this test', () => {
    console.warn('this is a totally unmatched sentinel warning xyz123');
    expect(true).toBe(true);
  });
});
