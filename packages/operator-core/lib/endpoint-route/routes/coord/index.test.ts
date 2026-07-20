/**
 * coord/index.test.ts — loadCoordInbox (EI-18138089781782660 follow-up, WI-5618).
 *
 * loadCoordInbox used to read the WHOLE coord corpus every call
 * (readAllMessages() / listEscalations({}) / listHandoffs({}), each an
 * unbounded full-surface event replay), then filter down to the human-facing
 * subset in JS — cost grew unboundedly with total coord volume, the same
 * anti-pattern loadCoordHistory had before its own fix. This pins that it now
 * uses the same BOUNDED primitives loadCoordHistory uses (readLinesBounded /
 * listEscalationsPaginated / listHandoffsPaginated) — never the unbounded
 * readLines/listEscalations({})/listHandoffs({}) — while preserving the exact
 * same filter semantics: messages/handoffs addressed to `'human'`, and only
 * OPEN (unresolved) escalations.
 *
 * `@papercusp/agent-mcp`'s `defineTool` and the `./inbox-sse` route are
 * mocked out (identity passthrough / no-op) purely to keep this a lean, pure
 * unit test of `loadCoordInbox`'s own logic — this file also defines HTTP
 * route objects and pulls in the coord_inbox PG-notify bus transitively via
 * inbox-sse.ts, neither of which this test exercises.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordEnvelope } from '../../../agent-tools/coordination/envelope';

const {
  readLinesBoundedMock,
  listEscalationsMock,
  listEscalationsPaginatedMock,
  listHandoffsMock,
  listHandoffsPaginatedMock,
} = vi.hoisted(() => ({
  readLinesBoundedMock: vi.fn(async () => [] as CoordEnvelope[]),
  listEscalationsMock: vi.fn(async () => []),
  listEscalationsPaginatedMock: vi.fn(async () => ({ escalations: [], truncated: false, total: 0 })),
  listHandoffsMock: vi.fn(async () => []),
  listHandoffsPaginatedMock: vi.fn(async () => ({ handoffs: [], truncated: false, total: 0 })),
}));

vi.mock('@papercusp/agent-mcp', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineTool: (spec: unknown) => spec as any,
}));
vi.mock('./inbox-sse', () => ({ default: {} }));
vi.mock('../../../agent-tools/coordination/log', () => ({
  coordLog: { readLinesBounded: readLinesBoundedMock },
}));
vi.mock('../../../agent-tools/coordination/escalations', () => ({
  listEscalations: listEscalationsMock,
  listEscalationsPaginated: listEscalationsPaginatedMock,
}));
vi.mock('../../../agent-tools/coordination/handoffs', () => ({
  listHandoffs: listHandoffsMock,
  listHandoffsPaginated: listHandoffsPaginatedMock,
}));
vi.mock('../../../agent-tools/coordination/plan-events', () => ({ readPlanEvents: vi.fn(async () => []) }));

import { loadCoordInbox } from './index';

function msg(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return { ts: '2026-07-20T00:00:00.000Z', msg_id: 'm0', from: 'alice', to: ['bob'], kind: 'message', ...p };
}

beforeEach(() => {
  vi.clearAllMocks();
  readLinesBoundedMock.mockResolvedValue([]);
  listEscalationsPaginatedMock.mockResolvedValue({ escalations: [], truncated: false, total: 0 });
  listHandoffsPaginatedMock.mockResolvedValue({ handoffs: [], truncated: false, total: 0 });
});

describe('loadCoordInbox — bounded reads (EI-18138089781782660 follow-up)', () => {
  it('reads messages via readLinesBounded (never the unbounded readLines) and filters to `to: human`', async () => {
    readLinesBoundedMock.mockResolvedValueOnce([
      msg({ msg_id: 'm1', to: ['human'] }),
      msg({ msg_id: 'm2', to: ['bob'] }),
    ]);
    const items = await loadCoordInbox();
    expect(readLinesBoundedMock).toHaveBeenCalledWith('messages', expect.objectContaining({ limit: expect.any(Number) }));
    expect(items.map((i) => i.msg_id)).toEqual(['m1']);
  });

  it('requests escalations via listEscalationsPaginated({ status: "open" }) — no JS resolved==null filter, no unbounded listEscalations({}) call', async () => {
    listEscalationsPaginatedMock.mockResolvedValueOnce({
      escalations: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ts: '2026-07-20T00:00:00.000Z', msg_id: 'e1', from: 'x', to: ['human'], kind: 'escalation', severity: 'question', summary: 's', resolved: null } as any,
      ],
      truncated: false,
      total: 1,
    });
    const items = await loadCoordInbox();
    expect(listEscalationsPaginatedMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'open' }));
    expect(listEscalationsMock).not.toHaveBeenCalled();
    expect(items.map((i) => i.msg_id)).toContain('e1');
  });

  it('reads handoffs via listHandoffsPaginated (never the unbounded listHandoffs({})) and filters to `to: human`', async () => {
    listHandoffsPaginatedMock.mockResolvedValueOnce({
      handoffs: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { record: { ts: '2026-07-20T00:00:00.000Z', msg_id: 'h1', from: 'x', to: ['human'], kind: 'handoff' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { record: { ts: '2026-07-20T00:00:00.000Z', msg_id: 'h2', from: 'x', to: ['someone-else'], kind: 'handoff' } } as any,
      ],
      truncated: false,
      total: 2,
    });
    const items = await loadCoordInbox();
    expect(listHandoffsMock).not.toHaveBeenCalled();
    expect(items.map((i) => i.msg_id)).toEqual(['h1']);
  });

  it('never falls back to the unbounded full-corpus reads', async () => {
    await loadCoordInbox();
    expect(listEscalationsMock).not.toHaveBeenCalled();
    expect(listHandoffsMock).not.toHaveBeenCalled();
  });

  it('merges all three surfaces and sorts newest-first', async () => {
    readLinesBoundedMock.mockResolvedValueOnce([
      msg({ msg_id: 'm-old', to: ['human'], ts: '2026-01-01T00:00:00.000Z' }),
    ]);
    listEscalationsPaginatedMock.mockResolvedValueOnce({
      escalations: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ts: '2026-06-01T00:00:00.000Z', msg_id: 'e-new', from: 'x', to: ['human'], kind: 'escalation', severity: 'question', summary: 's', resolved: null } as any,
      ],
      truncated: false,
      total: 1,
    });
    const items = await loadCoordInbox();
    expect(items.map((i) => i.msg_id)).toEqual(['e-new', 'm-old']);
  });
});
