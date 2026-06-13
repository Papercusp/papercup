import { describe, it, expect } from 'vitest';
import { mergeBrief } from './place_batch';

describe('mergeBrief — per-lane brief + Queen overlay (queen-wave-dispatch P-031)', () => {
  it('combines the lane brief and the batch overlay, lane first', () => {
    expect(mergeBrief('lane context', 'queen overlay')).toBe('lane context\n\nqueen overlay');
  });

  it('returns whichever single brief is present', () => {
    expect(mergeBrief('lane only', null)).toBe('lane only');
    expect(mergeBrief(null, 'overlay only')).toBe('overlay only');
    expect(mergeBrief('lane only', undefined)).toBe('lane only');
    expect(mergeBrief(undefined, 'overlay only')).toBe('overlay only');
  });

  it('treats whitespace-only as absent and returns null when neither is real', () => {
    expect(mergeBrief('   ', '')).toBeNull();
    expect(mergeBrief(null, undefined)).toBeNull();
    expect(mergeBrief('  ', 'real')).toBe('real');
  });
});
