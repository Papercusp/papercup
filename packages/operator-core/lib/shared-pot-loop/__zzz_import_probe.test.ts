import { describe, it, expect } from 'vitest';

describe('import probe', () => {
  it('imports composition-rig.ts cleanly', async () => {
    const mod = await import('./composition-rig.ts');
    expect(mod).toBeTruthy();
  }, 15000);
});
