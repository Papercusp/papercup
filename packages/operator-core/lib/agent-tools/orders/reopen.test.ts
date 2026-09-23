/**
 * reopen.test.ts — orders:reopen (directive-ownership-clarity-2026-09-23 P-007).
 *
 * The case that motivates the verb: on 2026-09-23 an agent closed five OTHER
 * sessions' directives by mistake and could only undo it with raw SQL. So the
 * closer must be able to reopen what IT closed even though the directive is not
 * addressed to it, while an unrelated session still may not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getOwnerDirective: vi.fn(),
  reopenOwnerDirective: vi.fn(),
  directiveActionVerdict: vi.fn(),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-mine' })),
  activeWorkspaceId: vi.fn(() => 'papercusp-workspace'),
}));

vi.mock('../../owner-directives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directives')>();
  return { ...actual, getOwnerDirective: h.getOwnerDirective, reopenOwnerDirective: h.reopenOwnerDirective };
});
vi.mock('../../owner-directive-agenda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directive-agenda')>();
  return { ...actual, directiveActionVerdict: h.directiveActionVerdict };
});
vi.mock('../coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/identity')>();
  return { ...actual, resolveAgentIdentity: h.resolveAgentIdentity };
});
vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: h.activeWorkspaceId };
});

const tool = (await import('./reopen')).default;
const CTX = { uiClientId: 'pus-test', isPowerUser: false } as never;

async function call(args: Record<string, unknown>) {
  const r = (await tool.handler(args as never, CTX)) as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: r.isError, body: JSON.parse(r.content[0]!.text) as Record<string, unknown> };
}

const CLOSED = (dispositionedBy: string) => ({
  id: 248,
  workspaceId: 'papercusp-workspace',
  recordedBy: 'su-theirs',
  dispositionStatus: 'done',
  dispositionedBy,
});

beforeEach(() => {
  for (const f of [h.getOwnerDirective, h.reopenOwnerDirective, h.directiveActionVerdict]) f.mockReset();
  h.reopenOwnerDirective.mockResolvedValue({ ok: true, row: { id: 248, reopenedFrom: 'done by su-mine at …: x' } });
});

describe('orders:reopen', () => {
  it('the session that made a WRONG close of someone else\'s directive can reopen it', async () => {
    h.getOwnerDirective.mockResolvedValue(CLOSED('su-mine'));

    const { isError, body } = await call({ id: 248, reason: 'closed it by a text match; it is su-theirs\'s' });

    expect(isError).toBeUndefined();
    expect(body.because).toBe('closed-it');
    expect(h.directiveActionVerdict).not.toHaveBeenCalled();
    expect(h.reopenOwnerDirective).toHaveBeenCalledWith({
      id: 248,
      workspaceId: 'papercusp-workspace',
      reason: "closed it by a text match; it is su-theirs's",
      reopenedBy: 'su-mine',
    });
  });

  it('the addressee can reopen a directive someone else closed', async () => {
    h.getOwnerDirective.mockResolvedValue(CLOSED('su-other'));
    h.directiveActionVerdict.mockResolvedValue({ allowed: true, because: 'addressee' });

    const { isError } = await call({ id: 248, reason: 'not actually done' });

    expect(isError).toBeUndefined();
    expect(h.reopenOwnerDirective).toHaveBeenCalledTimes(1);
  });

  it('an UNRELATED session is refused and nothing is written', async () => {
    h.getOwnerDirective.mockResolvedValue(CLOSED('su-other'));
    h.directiveActionVerdict.mockResolvedValue({ allowed: false, addressedTo: 'su-theirs', holders: [] });

    const { isError, body } = await call({ id: 248, reason: 'looks unfinished' });

    expect(isError).toBe(true);
    expect(body.error).toBe('foreign_directive');
    expect(body.closedBy).toBe('su-other');
    expect(h.reopenOwnerDirective).not.toHaveBeenCalled();
  });

  it('an unreadable verdict refuses retryably (fail closed) and writes nothing', async () => {
    h.getOwnerDirective.mockResolvedValue(CLOSED('su-other'));
    h.directiveActionVerdict.mockRejectedValue(new Error('pg down'));

    const { isError, body } = await call({ id: 248, reason: 'not actually done' });

    expect(isError).toBe(true);
    expect(body.error).toBe('verdict_unavailable');
    expect(body.retryable).toBe(true);
    expect(h.reopenOwnerDirective).not.toHaveBeenCalled();
  });

  it('an already-open directive is reported, not "reopened"', async () => {
    h.getOwnerDirective.mockResolvedValue({ ...CLOSED('su-mine'), dispositionStatus: null, dispositionedBy: null });

    const { body } = await call({ id: 248, reason: 'just in case' });

    expect(body.error).toBe('not_dispositioned');
    expect(h.reopenOwnerDirective).not.toHaveBeenCalled();
  });

  it('a directive in another workspace is not found', async () => {
    h.getOwnerDirective.mockResolvedValue({ ...CLOSED('su-mine'), workspaceId: 'other-workspace' });

    const { body } = await call({ id: 248, reason: 'wrong workspace' });

    expect(body.error).toBe('not_found');
    expect(h.reopenOwnerDirective).not.toHaveBeenCalled();
  });
});
