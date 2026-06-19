/**
 * coord_categorize.test.ts — the dev:coord_categorize HANDLER (sql mocked to return
 * corpus rows; the pure categorizers are mocked + tested separately). Pins the handler's
 * own logic: the type-guarded extraction of each row's body into a CoordMsgLike (string
 * guards on kind/summary/body/lifecycle; auto === true; a null body → all-undefined), and
 * the residual-sample (filter to 'contextual', slice to `sample`, truncate to 140 chars).
 * A regression in the body extraction (e.g. leaking a non-string field) or the truncation
 * is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/coord_categorize.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: vi.fn(async () => h.rows) })),
}));
vi.mock('../../coord-lifecycle/corpus-categorize', () => ({
  categorizeCorpus: vi.fn(() => ({ total: 0 })),
  categorizeCoordMessage: vi.fn(() => 'other'),
}));

import { categorizeCorpus, categorizeCoordMessage } from '../../coord-lifecycle/corpus-categorize';
const corpusM = vi.mocked(categorizeCorpus);
const msgM = vi.mocked(categorizeCoordMessage);
const tool = (await import('./coord_categorize')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  corpusM.mockReturnValue({ total: 3, contextualPct: 33, automatedPct: 50 } as never);
});

describe('dev:coord_categorize handler', () => {
  it('extracts each row body (type-guarded) and spreads the corpus report + residual sample', async () => {
    h.rows = [
      { body: { kind: 'completion', summary: 'done', auto: true, lifecycle: 'completion' } },
      { body: { summary: 'CTX free chat' } },
      { body: null },
    ];
    msgM.mockImplementation((m: { summary?: string }) => (m.summary === 'CTX free chat' ? 'contextual' : 'other') as never);

    const b = body(await call());
    expect(b).toMatchObject({ ok: true, total: 3, contextualPct: 33, automatedPct: 50, residualSample: ['CTX free chat'] });

    // the mapped CoordMsgLike[] fed to the categorizer
    const msgs = corpusM.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ kind: 'completion', summary: 'done', body: undefined, auto: true, lifecycle: 'completion' });
    expect(msgs[2]).toEqual({ kind: undefined, summary: undefined, body: undefined, auto: false, lifecycle: undefined });
  });

  it('truncates each residual sample to 140 chars and honors the sample cap', async () => {
    h.rows = [{ body: { summary: 'CTX' + 'y'.repeat(300) } }, { body: { summary: 'CTX second' } }];
    msgM.mockReturnValue('contextual' as never);
    const b = body(await call({ sample: 1 }));
    expect(b.residualSample).toHaveLength(1); // sample cap
    expect(b.residualSample[0]).toHaveLength(140); // truncated
  });
});
