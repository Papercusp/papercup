/**
 * operator:dedup_check — MCP tool handler + arg-schema coverage.
 *
 * The sibling `__tests__/misc.test.ts` covers the happy/null handler
 * payload. This dedicated file pins the parts that file does not:
 *   - the Zod `args` schema (candidate non-empty, existing rows shaped
 *     {id,title} both non-empty) — accept/reject cases
 *   - the threshold echo always reflects the lib's FUZZY_THRESHOLD
 *     (not a hard-coded literal in the handler)
 *   - the candidate + existing are forwarded to findFuzzyDuplicate verbatim
 *
 * The underlying pure fn (`findFuzzyDuplicate`) is mocked so the handler
 * is tested in isolation and stays independent of the dedup algorithm.
 *
 * Note `tool.handler` is the raw role-gated handler — it does NOT run the
 * Zod `args` validation (the projection wrapper does, at dispatch time).
 * So arg-validation is asserted against `tool.args` directly, which is the
 * exact schema the wrapper enforces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  }) as never;

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../operator-fuzzy-dedup');
});

describe('operator:dedup_check — handler', () => {
  it('forwards candidate + existing to findFuzzyDuplicate and echoes the lib threshold', async () => {
    const findFuzzyDuplicate = vi.fn(() => ({ matchedId: 'a1', similarity: 0.9 }));
    vi.doMock('../../operator-fuzzy-dedup', () => ({
      findFuzzyDuplicate,
      FUZZY_THRESHOLD: 0.82,
    }));
    const { default: tool } = await import('./dedup_check');
    const existing = [{ id: 'a1', title: 'Y' }];
    const result = await tool.handler({ candidate: 'X', existing }, MAKE_CTX());
    // forwarded verbatim
    expect(findFuzzyDuplicate).toHaveBeenCalledWith('X', existing);
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      match: { matchedId: 'a1', similarity: 0.9 },
      threshold: 0.82,
    });
  });

  it('returns match:null when no candidate clears the threshold', async () => {
    vi.doMock('../../operator-fuzzy-dedup', () => ({
      findFuzzyDuplicate: vi.fn(() => null),
      FUZZY_THRESHOLD: 0.82,
    }));
    const { default: tool } = await import('./dedup_check');
    const result = await tool.handler({ candidate: 'X', existing: [] }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload.match).toBeNull();
    expect(payload.threshold).toBe(0.82);
  });

  it('echoes whatever FUZZY_THRESHOLD the lib exports (not a hard-coded literal)', async () => {
    // If the project re-tunes the threshold, the handler must echo the new value.
    vi.doMock('../../operator-fuzzy-dedup', () => ({
      findFuzzyDuplicate: vi.fn(() => null),
      FUZZY_THRESHOLD: 0.5,
    }));
    const { default: tool } = await import('./dedup_check');
    const result = await tool.handler({ candidate: 'X', existing: [] }, MAKE_CTX());
    expect(parsePayload(result as never).threshold).toBe(0.5);
  });
});

describe('operator:dedup_check — args schema (Zod validation surface)', () => {
  async function getArgs() {
    vi.doMock('../../operator-fuzzy-dedup', () => ({
      findFuzzyDuplicate: vi.fn(() => null),
      FUZZY_THRESHOLD: 0.82,
    }));
    const { default: tool } = await import('./dedup_check');
    return tool.args;
  }

  it('accepts a well-formed candidate + existing list', async () => {
    const args = await getArgs();
    const parsed = args.safeParse({
      candidate: 'Run validator',
      existing: [{ id: 'a', title: 'Run validator on F-001' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty existing list', async () => {
    const args = await getArgs();
    expect(args.safeParse({ candidate: 'x', existing: [] }).success).toBe(true);
  });

  it('rejects an empty candidate string', async () => {
    const args = await getArgs();
    expect(args.safeParse({ candidate: '', existing: [] }).success).toBe(false);
  });

  it('rejects a missing candidate', async () => {
    const args = await getArgs();
    expect(args.safeParse({ existing: [] }).success).toBe(false);
  });

  it('rejects an existing row with an empty id', async () => {
    const args = await getArgs();
    expect(
      args.safeParse({ candidate: 'x', existing: [{ id: '', title: 't' }] }).success,
    ).toBe(false);
  });

  it('rejects an existing row with an empty title', async () => {
    const args = await getArgs();
    expect(
      args.safeParse({ candidate: 'x', existing: [{ id: 'a', title: '' }] }).success,
    ).toBe(false);
  });

  it('rejects existing rows missing the title field', async () => {
    const args = await getArgs();
    expect(
      args.safeParse({ candidate: 'x', existing: [{ id: 'a' }] }).success,
    ).toBe(false);
  });
});
