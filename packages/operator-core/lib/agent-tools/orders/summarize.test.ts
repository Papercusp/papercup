/**
 * orders:summarize — the forced summary of an over-cap owner directive
 * (owner-directive-delivery-redesign-2026-09-22, P-003 / D-004).
 *
 * The summary REPLACES the owner's words for every other agent, so the verb
 * carries the same ownership rail as orders:disposition: a foreign caller is
 * refused and nothing is written. Refusals assert the ABSENCE of the write, not
 * only the error envelope.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  summarizeOwnerDirective: vi.fn(),
  directiveActionVerdict: vi.fn(),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-mine' })),
  activeWorkspaceId: vi.fn(() => 'papercusp-workspace'),
}));

vi.mock('../../owner-directives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directives')>();
  return { ...actual, summarizeOwnerDirective: h.summarizeOwnerDirective };
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

const tool = (await import('./summarize')).default;
const { OWNER_DIRECTIVE_SUMMARY_MAX } = await import('../../owner-directives');

const CTX = { uiClientId: 'pus-test', isPowerUser: false } as never;

function envelopeOf(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function call(args: Record<string, unknown>) {
  return (await tool.handler(args as never, CTX)) as { content: Array<{ text: string }>; isError?: boolean };
}

beforeEach(() => {
  h.summarizeOwnerDirective.mockReset();
  h.directiveActionVerdict.mockReset();
  h.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-mine' });
  h.activeWorkspaceId.mockReturnValue('papercusp-workspace');
});

describe('orders:summarize', () => {
  it('the addressee writes the summary, attributed to itself', async () => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: true, because: 'addressee' });
    h.summarizeOwnerDirective.mockResolvedValue({ ok: true, row: { id: 7, summaryText: 'ship the redesign' } });

    const result = await call({ id: 7, summary: 'ship the redesign' });

    expect(result.isError).toBeUndefined();
    expect(envelopeOf(result)).toEqual({ ok: true, id: 7, summary: 'ship the redesign' });
    expect(h.summarizeOwnerDirective).toHaveBeenCalledWith({ id: 7, summary: 'ship the redesign', summarizedBy: 'su-mine' });
  });

  it('refuses a FOREIGN directive, names the addressee, and writes nothing', async () => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: false, addressedTo: 'su-theirs', holders: [] });

    const result = await call({ id: 7, summary: 'my reading of their order' });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result)).toMatchObject({ ok: false, error: 'foreign_directive', addressedTo: 'su-theirs' });
    expect(h.summarizeOwnerDirective).not.toHaveBeenCalled();
  });

  it('an unknown id refuses as not_found, not as foreign', async () => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: false, notFound: true });

    const result = await call({ id: 404, summary: 'no such directive' });

    expect(envelopeOf(result).error).toBe('not_found');
    expect(h.summarizeOwnerDirective).not.toHaveBeenCalled();
  });

  it('surfaces a store refusal (e.g. summary_not_needed) as isError, never a false success', async () => {
    h.directiveActionVerdict.mockResolvedValue({ allowed: true, because: 'addressee' });
    h.summarizeOwnerDirective.mockResolvedValue({ ok: false, error: 'summary_not_needed' });

    const result = await call({ id: 7, summary: 'short one anyway' });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result)).toEqual({ ok: false, id: 7, error: 'summary_not_needed' });
  });

  it('the schema caps the summary at OWNER_DIRECTIVE_SUMMARY_MAX', () => {
    expect(tool.args.safeParse({ id: 7, summary: 'x'.repeat(OWNER_DIRECTIVE_SUMMARY_MAX) }).success).toBe(true);
    expect(tool.args.safeParse({ id: 7, summary: 'x'.repeat(OWNER_DIRECTIVE_SUMMARY_MAX + 1) }).success).toBe(false);
  });
});
