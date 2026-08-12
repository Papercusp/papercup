import { describe, expect, it } from 'vitest';

const tool = (await import('./release')).default;

describe('locks:release UUID validation', () => {
  it('accepts a complete lock UUID', () => {
    expect(tool.args.safeParse({ lock_id: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
  });

  it('identifies a short lock_id as likely truncated', () => {
    const result = tool.args.safeParse({ lock_id: '11111111-1111-1111-1111' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain('23 characters');
    expect(result.error.issues[0]?.message).toContain('may be truncated');
    expect(result.error.issues[0]?.message).toContain('locks:acquire or locks:queue');
  });

  it('uses the same actionable diagnostic for a short lock_ids entry', () => {
    const result = tool.args.safeParse({ lock_ids: ['11111111-1111-1111-1111'] });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain('23 characters');
    expect(result.error.issues[0]?.message).toContain('may be truncated');
  });

  it('keeps UUID format metadata in the generated JSON schema', () => {
    const jsonSchema = tool.args.toJSONSchema();

    expect(jsonSchema.properties?.lock_id).toMatchObject({ type: 'string', format: 'uuid' });
    expect(jsonSchema.properties?.lock_ids).toMatchObject({
      type: 'array',
      items: { type: 'string', format: 'uuid' },
    });
  });
});
