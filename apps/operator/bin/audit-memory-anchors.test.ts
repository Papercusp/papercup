import { describe, it, expect } from 'vitest';
// Smoke-import only: the CLI wraps pg in a runtime require inside
// `audit()`; importing the module doesn't open a connection.
import { audit } from './audit-memory-anchors';

describe('audit-memory-anchors CLI', () => {
  it('module imports cleanly without opening a pg connection', () => {
    expect(typeof audit).toBe('function');
  });
});
