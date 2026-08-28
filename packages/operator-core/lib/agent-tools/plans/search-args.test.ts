import { describe, expect, it } from 'vitest';
import searchTool from './search';

const schema = searchTool.args as {
  safeParse: (value: unknown) => {
    success: boolean;
    data?: Record<string, unknown>;
  };
};

describe('plans:search argument normalization', () => {
  it('accepts q-only callers and normalizes q to query', () => {
    const parsed = schema.safeParse({ q: 'legacy term' });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ query: 'legacy term' });
    expect(parsed.data).not.toHaveProperty('q');
  });

  it('prefers query when callers provide both query and q', () => {
    const parsed = schema.safeParse({ query: 'canonical term', q: 'legacy term' });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ query: 'canonical term' });
    expect(parsed.data).not.toHaveProperty('q');
  });
});
