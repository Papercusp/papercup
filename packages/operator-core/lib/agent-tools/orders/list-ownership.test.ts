/**
 * list-ownership.test.ts — orders:list says whose each directive is
 * (directive-ownership-clarity-2026-09-23 P-003).
 *
 * On 2026-09-23 an agent regex-filtered this list by text and closed five other
 * sessions' copies of one pasted report. Every row now carries `mine` and
 * `addressedTo`, your rows come first, and the rest are grouped per session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listOwnerDirectives: vi.fn(),
  listClearedDirectiveIds: vi.fn(async () => new Set<number>()),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-mine' })),
}));

vi.mock('../../owner-directives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directives')>();
  return { ...actual, listOwnerDirectives: h.listOwnerDirectives };
});
vi.mock('../../owner-directive-agenda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../owner-directive-agenda')>();
  return { ...actual, listClearedDirectiveIds: h.listClearedDirectiveIds };
});
vi.mock('../coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/identity')>();
  return { ...actual, resolveAgentIdentity: h.resolveAgentIdentity };
});

const tool = (await import('./list')).default;
const CTX = { uiClientId: 'pus-test', isPowerUser: false, workspaceId: 'papercusp-workspace' } as never;

const REPORT = 'Another agent ran into similar issues and wrote this report and plan';
const row = (id: number, recordedBy: string) => ({
  id,
  workspaceId: 'papercusp-workspace',
  ownerId: 'owner',
  sessionRef: null,
  sourceTurnRef: null,
  verbatimText: REPORT,
  recordedBy,
  createdAtMs: 1_790_000_000_000 + id,
  dispositionedAtMs: null,
  dispositionStatus: null,
  dispositionNote: null,
  dispositionedBy: null,
});

beforeEach(() => {
  h.listOwnerDirectives.mockReset();
});

describe('orders:list — ownership on every row', () => {
  it('identical text in three sessions: only MY row is mine, it comes first, and the rest group by session', async () => {
    h.listOwnerDirectives.mockResolvedValue([row(248, 'su-a'), row(268, 'su-mine'), row(252, 'su-a'), row(256, 'su-b')]);

    const r = (await tool.handler({ open: true } as never, CTX)) as { content: Array<{ text: string }> };
    const body = JSON.parse(r.content[0]!.text) as {
      yours: number[];
      byAddressee: Record<string, number[]>;
      directives: Array<{ id: number; mine: boolean; addressedTo: string }>;
    };

    expect(body.yours).toEqual([268]);
    expect(body.byAddressee).toEqual({ 'su-a': [248, 252], 'su-b': [256] });
    expect(body.directives[0]).toMatchObject({ id: 268, mine: true, addressedTo: 'su-mine' });
    expect(body.directives.filter((d) => d.mine).map((d) => d.id)).toEqual([268]);
  });

  it('D-004(1): a row whose text is open in other sessions carries alsoSentTo + the note; a unique row carries neither', async () => {
    h.listOwnerDirectives.mockResolvedValue([
      { ...row(268, 'su-mine'), otherSessionCopies: 2 },
      { ...row(270, 'su-mine'), verbatimText: 'something only I was told', otherSessionCopies: 0 },
    ]);

    const r = (await tool.handler({ open: true } as never, CTX)) as { content: Array<{ text: string }> };
    const body = JSON.parse(r.content[0]!.text) as { directives: Array<Record<string, unknown>> };

    expect(body.directives[0]).toMatchObject({
      id: 268,
      alsoSentTo: 2,
      alsoSentNote: "(also sent to 2 other sessions; each copy is its own addressee's to close)",
    });
    expect(body.directives[1]).not.toHaveProperty('alsoSentTo');
    expect(body.directives[1]).not.toHaveProperty('alsoSentNote');
  });
});
