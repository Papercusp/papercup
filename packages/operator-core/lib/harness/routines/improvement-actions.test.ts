import { describe, it, expect } from 'vitest';
// Side-effect import registers the two actions (and exercises every import path).
import './improvement-actions';
import { listSystemActions } from './system-actions';

describe('improvement-actions registration', () => {
  it('registers system:improvement-digest and system:improvement-implement', () => {
    const actions = listSystemActions();
    expect(actions).toContain('improvement-digest');
    expect(actions).toContain('improvement-implement');
  });
});
