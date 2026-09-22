/**
 * search.test.ts — the rubrics:search TOOL (EI-21914820970269971).
 *
 * `searchRubrics` scopes to kind:'standard' by default, deliberately excluding the
 * unbounded per-plan `acceptance` population from the shared-standards library
 * (rubrics.ts). That default makes a scoped-empty result look exactly like genuine
 * absence — a real active rubric of the OTHER kind can match the same query and the
 * caller never sees it, risking a duplicate rubrics:propose. This pins the
 * `scopeNote` guard: a single-kind search that finds nothing checks the other kind
 * and says so instead of returning a silent `count: 0`.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/rubrics/search.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../rubrics', () => ({ searchRubrics: vi.fn() }));

import { searchRubrics } from '../../rubrics';
import type { Rubric } from '../../rubrics';
import { mockImplementationTyped } from '../../testing/typed-mock';

const searchM = vi.mocked(searchRubrics);

const tool = (await import('./search')).default;

type Out = { content: { text: string }[] };
const body = async (args: unknown) =>
  JSON.parse(((await tool.handler(args as never, {} as never)) as Out).content[0]!.text);

/** A minimal, correctly-typed `Rubric` fixture — only rubricId/kind vary per test. */
function fixture(rubricId: string, kind: Rubric['kind']): Rubric {
  return {
    rubricId,
    workspaceId: 'papercusp-workspace',
    kind,
    gradingAuthority: 'independent',
    characteristic: 'c',
    title: rubricId,
    description: '',
    criteria: [],
    ratingScale: [],
    methodRef: null,
    status: 'active',
    createdBy: null,
    proposedBy: null,
    ratifiedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => vi.clearAllMocks());

describe('rubrics:search scopeNote guard', () => {
  it('defaults to kind:standard and passes it through unchanged', async () => {
    mockImplementationTyped(searchM, async () => []);
    await body({ query: 'x' });
    expect(searchM).toHaveBeenCalledWith('x', undefined, 'standard');
  });

  it('standard-kind results present: no scopeNote, no second lookup', async () => {
    mockImplementationTyped(searchM, async (_q, _limit, kind) =>
      kind === 'standard' ? [fixture('std-1', 'standard')] : [],
    );
    const b = await body({ query: 'tui-status-parity' });
    expect(b.count).toBe(1);
    expect(b.scopeNote).toBeUndefined();
    expect(searchM).toHaveBeenCalledTimes(1);
  });

  it('0 standard-kind results but an acceptance-kind rubric matches: scopeNote names it', async () => {
    mockImplementationTyped(searchM, async (_q, _limit, kind) =>
      kind === 'acceptance' ? [fixture('acceptance-tui-status-parity-single-source-2026-07-05-successor-2026-08-30', 'acceptance')] : [],
    );
    const b = await body({ query: 'tui-status-parity' });
    expect(b.count).toBe(0);
    expect(searchM).toHaveBeenCalledWith('tui-status-parity', undefined, 'standard');
    expect(searchM).toHaveBeenCalledWith('tui-status-parity', undefined, 'acceptance');
    expect(searchM).toHaveBeenCalledTimes(2);
    expect(b.scopeNote).toMatch(/1 acceptance-kind rubric/);
    expect(b.scopeNote).toMatch(/acceptance-tui-status-parity-single-source-2026-07-05-successor-2026-08-30/);
    expect(b.scopeNote).toMatch(/kind:'any'/);
  });

  it('explicit kind:acceptance, 0 matches, a standard-kind rubric matches: symmetric scopeNote', async () => {
    mockImplementationTyped(searchM, async (_q, _limit, kind) =>
      kind === 'standard' ? [fixture('std-1', 'standard')] : [],
    );
    const b = await body({ query: 'x', kind: 'acceptance' });
    expect(b.count).toBe(0);
    expect(searchM).toHaveBeenCalledWith('x', undefined, 'acceptance');
    expect(searchM).toHaveBeenCalledWith('x', undefined, 'standard');
    expect(b.scopeNote).toMatch(/1 standard-kind rubric/);
  });

  it('genuinely absent in both kinds: no scopeNote', async () => {
    mockImplementationTyped(searchM, async () => []);
    const b = await body({ query: 'zzznotarubric' });
    expect(b.count).toBe(0);
    expect(b.scopeNote).toBeUndefined();
    expect(searchM).toHaveBeenCalledTimes(2);
  });

  it("kind:'any' with 0 results never triggers a second lookup", async () => {
    mockImplementationTyped(searchM, async () => []);
    const b = await body({ query: 'zzznotarubric', kind: 'any' });
    expect(b.count).toBe(0);
    expect(b.scopeNote).toBeUndefined();
    expect(searchM).toHaveBeenCalledTimes(1);
    expect(searchM).toHaveBeenCalledWith('zzznotarubric', undefined, 'any');
  });
});
