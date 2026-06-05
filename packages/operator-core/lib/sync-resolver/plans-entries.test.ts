/**
 * plans.* named-query resolvers — verify each entry dispatches the right
 * plans:* read verb and unwraps the tool envelope to a flat row array.
 * The canonical tool dispatch (read-dispatch.ts) is mocked, so this is a
 * pure unwrap-contract test (no tool host / filesystem needed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const callPlansRead = vi.fn();
vi.mock('../agent-tools/plans/read-dispatch', () => ({
  callPlansRead: (...a: unknown[]) => callPlansRead(...a),
  callPlansReadRaw: vi.fn(),
}));

import { resolveNamedQueryV2 } from '.';

beforeEach(() => callPlansRead.mockReset());

describe('plans.* resolvers — verb dispatch + envelope unwrap', () => {
  it('plans.list → list verb, unwraps .plans, passes args through', async () => {
    callPlansRead.mockResolvedValue({ plans: [{ slug: 'a' }, { slug: 'b' }] });
    const rows = await resolveNamedQueryV2('plans.list', { includeArchived: true });
    expect(callPlansRead).toHaveBeenCalledWith('list', { includeArchived: true });
    expect(rows).toEqual([{ slug: 'a' }, { slug: 'b' }]);
  });

  it('plans.items → items verb, unwraps .items', async () => {
    callPlansRead.mockResolvedValue({ items: [{ plan: 'a' }] });
    expect(await resolveNamedQueryV2('plans.items', { needsHuman: true })).toEqual([{ plan: 'a' }]);
    expect(callPlansRead).toHaveBeenCalledWith('items', { needsHuman: true });
  });

  it('plans.attention → attention verb, unwraps .groups', async () => {
    callPlansRead.mockResolvedValue({ groups: [{ key: 'g1' }] });
    expect(await resolveNamedQueryV2('plans.attention', { harnessSlug: 'x' })).toEqual([{ key: 'g1' }]);
  });

  it('plans.search → search verb, unwraps .hits', async () => {
    callPlansRead.mockResolvedValue({ hits: [{ plan: 'a', score: 1 }] });
    expect(await resolveNamedQueryV2('plans.search', { query: 'q' })).toEqual([{ plan: 'a', score: 1 }]);
  });

  it('plans.get → get verb, wraps the single object in a 1-element array', async () => {
    callPlansRead.mockResolvedValue({ slug: 'a', raw: '# plan' });
    expect(await resolveNamedQueryV2('plans.get', { slug: 'a' })).toEqual([{ slug: 'a', raw: '# plan' }]);
  });

  it('plans.get returns [] when the read yields null/undefined', async () => {
    callPlansRead.mockResolvedValue(null);
    expect(await resolveNamedQueryV2('plans.get', { slug: 'x' })).toEqual([]);
  });

  it('plans.revisions / plans.runs / plans.lint unwrap their fields', async () => {
    callPlansRead.mockResolvedValueOnce({ revisions: [{ seq: 1 }] });
    expect(await resolveNamedQueryV2('plans.revisions', { slug: 'a' })).toEqual([{ seq: 1 }]);
    callPlansRead.mockResolvedValueOnce({ runs: [{ id: 1 }] });
    expect(await resolveNamedQueryV2('plans.runs', { slug: 'a' })).toEqual([{ id: 1 }]);
    callPlansRead.mockResolvedValueOnce({ reports: [{ slug: 'a', errors: [] }] });
    expect(await resolveNamedQueryV2('plans.lint', { slug: 'a' })).toEqual([{ slug: 'a', errors: [] }]);
  });

  it('returns [] when the expected envelope field is missing', async () => {
    callPlansRead.mockResolvedValue({});
    expect(await resolveNamedQueryV2('plans.list', {})).toEqual([]);
    expect(await resolveNamedQueryV2('plans.items', {})).toEqual([]);
  });
});
