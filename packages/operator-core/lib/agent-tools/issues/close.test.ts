/**
 * close.test.ts — the issues:close HANDLER (setIssueState mocked). Pins the default
 * state (omitted → 'resolved'), the explicit-state passthrough, the not_found mapping,
 * and the projection. A regression that defaults to the wrong lifecycle state, or
 * swallows a missing issue into a fake success, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/issues/close.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../issues-engineer', () => ({ setIssueState: vi.fn() }));

import { setIssueState } from '../../issues-engineer';
const setM = vi.mocked(setIssueState);
const tool = (await import('./close')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) => tool.handler({ id: 'EI-1', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('issues:close handler', () => {
  it('defaults to state=resolved when omitted', async () => {
    setM.mockResolvedValue({ id: 'EI-1', state: 'resolved' } as never);
    const b = body(await call({}));
    expect(setM).toHaveBeenCalledWith('EI-1', 'resolved', 'me');
    expect(b).toMatchObject({ ok: true, issue: { id: 'EI-1', state: 'resolved' } });
  });

  it('passes an explicit state through', async () => {
    setM.mockResolvedValue({ id: 'EI-1', state: 'closed' } as never);
    await call({ state: 'closed' });
    expect(setM).toHaveBeenCalledWith('EI-1', 'closed', 'me');
  });

  it('maps a missing issue to { ok:false, error }', async () => {
    setM.mockResolvedValue(null as never);
    expect(body(await call({}))).toMatchObject({ ok: false, error: 'issue not found' });
  });
});
