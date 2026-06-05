/**
 * operator:parse_suggestions — MCP tool handler + arg-schema coverage.
 *
 * The sibling `__tests__/misc.test.ts` covers the loadPreferences/override
 * forwarding. This dedicated file pins the parts that file does not:
 *   - the Zod `args` schema (text non-empty; preferencesOverride optional
 *     + unconstrained `unknown`)
 *   - the result envelope is the parser's ParseResult serialized verbatim
 *     into content[0].text
 *   - preferencesOverride plumb-through: when present, loadPreferences is
 *     NOT called and the override object is passed straight to the parser;
 *     when absent, loadPreferences supplies the prefs
 *
 * Both the parser (`parseSuggestions`) and `loadPreferences` are mocked so
 * the handler is tested in isolation and stays independent of the churning
 * @papercusp/rules-backed parser internals.
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
  vi.doUnmock('../../operator-suggestion-parser');
  vi.doUnmock('../../operator-preferences');
});

describe('operator:parse_suggestions — handler', () => {
  it('loads preferences automatically when no override and forwards (text, prefs)', async () => {
    const parseSuggestions = vi.fn(async () => ({ blocks: [], parseErrors: [] }));
    const prefs = { raw: 'x', standingApprovals: [] };
    const loadPreferences = vi.fn(async () => prefs);
    vi.doMock('../../operator-suggestion-parser', () => ({ parseSuggestions }));
    vi.doMock('../../operator-preferences', () => ({ loadPreferences }));

    const { default: tool } = await import('./parse_suggestions');
    await tool.handler({ text: 'some <suggestion> text' }, MAKE_CTX());

    expect(loadPreferences).toHaveBeenCalledTimes(1);
    expect(parseSuggestions).toHaveBeenCalledWith('some <suggestion> text', prefs);
  });

  it('uses preferencesOverride verbatim and skips loadPreferences when provided', async () => {
    const parseSuggestions = vi.fn(async () => ({ blocks: [], parseErrors: [] }));
    const loadPreferences = vi.fn(async () => ({ should_not_be_used: true }));
    vi.doMock('../../operator-suggestion-parser', () => ({ parseSuggestions }));
    vi.doMock('../../operator-preferences', () => ({ loadPreferences }));

    const override = { raw: 'override', standingApprovals: [{ capability: 'messages:write', targetHarness: 'foo', confirmedAt: '2026-05-01' }] };
    const { default: tool } = await import('./parse_suggestions');
    await tool.handler({ text: 'hi', preferencesOverride: override }, MAKE_CTX());

    expect(loadPreferences).not.toHaveBeenCalled();
    expect(parseSuggestions).toHaveBeenCalledWith('hi', override);
  });

  it('serializes the parser ParseResult verbatim into content[0].text', async () => {
    const result = {
      blocks: [{ suggestion: { raw: { id: 's1' }, actualTier: 'medium', auto_dispatch: false, provenanceFlags: {} } }],
      parseErrors: ['JSON parse failed: …'],
    };
    const parseSuggestions = vi.fn(async () => result);
    vi.doMock('../../operator-suggestion-parser', () => ({ parseSuggestions }));
    vi.doMock('../../operator-preferences', () => ({ loadPreferences: vi.fn(async () => ({ raw: '', standingApprovals: [] })) }));

    const { default: tool } = await import('./parse_suggestions');
    const out = await tool.handler({ text: 'whatever' }, MAKE_CTX());
    const payload = parsePayload(out as never);
    expect(payload).toEqual(result);
  });

  it('passes a falsy-but-present override (empty object) through without loading prefs', async () => {
    // `?? loadPreferences()` only falls back on null/undefined — an empty
    // object override is truthy-present and must be forwarded as-is.
    const parseSuggestions = vi.fn(async () => ({ blocks: [], parseErrors: [] }));
    const loadPreferences = vi.fn(async () => ({ raw: 'LOADED', standingApprovals: [] }));
    vi.doMock('../../operator-suggestion-parser', () => ({ parseSuggestions }));
    vi.doMock('../../operator-preferences', () => ({ loadPreferences }));

    const { default: tool } = await import('./parse_suggestions');
    await tool.handler({ text: 'hi', preferencesOverride: {} }, MAKE_CTX());

    expect(loadPreferences).not.toHaveBeenCalled();
    expect(parseSuggestions).toHaveBeenCalledWith('hi', {});
  });
});

describe('operator:parse_suggestions — args schema (Zod validation surface)', () => {
  async function getArgs() {
    vi.doMock('../../operator-suggestion-parser', () => ({ parseSuggestions: vi.fn(async () => ({ blocks: [], parseErrors: [] })) }));
    vi.doMock('../../operator-preferences', () => ({ loadPreferences: vi.fn(async () => ({ raw: '', standingApprovals: [] })) }));
    const { default: tool } = await import('./parse_suggestions');
    return tool.args;
  }

  it('accepts text alone (preferencesOverride optional)', async () => {
    const args = await getArgs();
    expect(args.safeParse({ text: 'hello' }).success).toBe(true);
  });

  it('accepts text plus an arbitrary preferencesOverride (unknown shape)', async () => {
    const args = await getArgs();
    expect(
      args.safeParse({ text: 'hello', preferencesOverride: { anything: [1, 2, 3] } }).success,
    ).toBe(true);
  });

  it('rejects an empty text string', async () => {
    const args = await getArgs();
    expect(args.safeParse({ text: '' }).success).toBe(false);
  });

  it('rejects a missing text field', async () => {
    const args = await getArgs();
    expect(args.safeParse({ preferencesOverride: {} }).success).toBe(false);
  });
});
