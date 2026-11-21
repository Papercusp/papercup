import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'authenticated-workspace' }));
import { bindSessionOutsidePlanRef, readSessionOutsidePlanRef, resolveSessionOutsidePlanRef, sessionOutsidePlanRefSchema } from './session-outside-plan';

describe('trusted session outside-plan binding', () => {
  beforeEach(() => sql.mockReset());

  it.each([199, 200])('preserves an opaque %i-character value intact', length => {
    const ref = ' x\n'.padEnd(length, 'y');
    expect(sessionOutsidePlanRefSchema.parse(ref)).toBe(ref);
  });
  it('rejects overflow intact and rejects an unrepresentable value', () => {
    expect(() => sessionOutsidePlanRefSchema.parse('x'.repeat(201))).toThrow();
    expect(() => sessionOutsidePlanRefSchema.parse('x\0y')).toThrow();
  });
  it('preserves whitespace-only labels and counts Unicode characters as PostgreSQL does', () => {
    expect(sessionOutsidePlanRefSchema.parse('   ')).toBe('   ');
    expect(sessionOutsidePlanRefSchema.parse('😀'.repeat(200))).toBe('😀'.repeat(200));
    expect(() => sessionOutsidePlanRefSchema.parse('😀'.repeat(200) + 'x')).toThrow();
  });
  it('keeps the ordinary no-reference path and inherits a persisted reference on resume', () => {
    expect(resolveSessionOutsidePlanRef(undefined, null, 'ordinary-plan')).toBeNull();
    expect(resolveSessionOutsidePlanRef(undefined, 'tracker:X')).toBe('tracker:X');
    expect(resolveSessionOutsidePlanRef('tracker:X', 'tracker:X')).toBe('tracker:X');
    expect(() => resolveSessionOutsidePlanRef('tracker:Y', 'tracker:X')).toThrow(/persisted/);
    expect(() => resolveSessionOutsidePlanRef('tracker:X', null, 'plan')).toThrow(/mutually exclusive/);
  });
  it('reads the latest persisted session in the authenticated workspace and ignores environment hints', async () => {
    sql.mockResolvedValueOnce([{ outside_plan_ref: 'tracker:X' }]).mockResolvedValueOnce([]);
    expect(await readSessionOutsidePlanRef('owner')).toBe('tracker:X');
    expect(sql.mock.calls[0].slice(1)).toEqual(['authenticated-workspace', 'owner']);
    expect(await readSessionOutsidePlanRef('owner', 'other-authenticated-workspace')).toBeNull();
    expect(sql.mock.calls[1].slice(1)).toEqual(['other-authenticated-workspace', 'owner']);
  });
  it('requires an exact workspace and owner match and an unconflicted stored binding', async () => {
    const input = { ownerId: 'owner', workspaceId: 'workspace', advSessionId: 42, planRef: 'tracker:X' };
    sql.mockResolvedValueOnce([{ id: 42 }]).mockResolvedValueOnce([]);
    await expect(bindSessionOutsidePlanRef(input)).resolves.toBeUndefined();
    const [query, ...params] = sql.mock.calls[0];
    expect(query.join('?')).toContain('plan_slug IS NULL');
    expect(query.join('?')).toContain('outside_plan_ref IS NULL OR outside_plan_ref =');
    expect(params).toEqual(['tracker:X', 42, 'workspace', 'owner', 'tracker:X']);
    await expect(bindSessionOutsidePlanRef(input)).rejects.toThrow(/conflicting/);
  });
});
