import { describe, expect, it } from 'vitest';

import {
  AGENT_CALL_ORIGINS,
  AUTOMATIC_CALL_ORIGINS,
  AUTOMATIC_TOOL_NAMES,
  DISPATCH_WRAPPER_EXCLUSION_SQL,
  DISPATCH_WRAPPER_METADATA_KEY,
  agentToolInvocationPredicate,
  automaticToolInvocationPredicate,
  classifyToolInvocationBehavior,
  dispatchWrapperExclusionPredicate,
  isDispatchWrapperMetadata,
} from './automatic-tool-names';

describe('tool invocation behavior classification', () => {
  it('uses explicit call_origin before the legacy tool-name fallback', () => {
    expect(classifyToolInvocationBehavior('coord:inbox', 'agent')).toBe('agent');
    expect(classifyToolInvocationBehavior('dev:pg_query', 'hook')).toBe('automatic');
    expect(classifyToolInvocationBehavior('dev:pg_query', 'ui')).toBe('automatic');
    expect(classifyToolInvocationBehavior('dev:pg_query', 'system')).toBe('automatic');
    expect(classifyToolInvocationBehavior('coord:inbox', 'unknown')).toBe('agent');
  });

  it('preserves the pre-migration NULL fallback and rejects invalid non-NULL values', () => {
    expect(classifyToolInvocationBehavior('coord:inbox', null)).toBe('automatic');
    expect(classifyToolInvocationBehavior('dev:pg_query', undefined)).toBe('agent');
    expect(classifyToolInvocationBehavior('dev:pg_query', 'not-a-real-origin')).toBe('unclassified');
  });
});

describe('tool invocation SQL predicates', () => {
  type SqlCall = { strings: readonly string[]; values: unknown[] };
  type SqlStub = ((strings: TemplateStringsArray, ...values: unknown[]) => unknown) & {
    unsafe(identifier: string): string;
    calls: SqlCall[];
  };

  function sqlStub(): SqlStub {
    const calls: SqlCall[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings: [...strings], values });
      return { kind: 'fragment', strings, values };
    }) as SqlStub;
    sql.calls = calls;
    sql.unsafe = (identifier: string) => identifier;
    return sql;
  }

  it('uses explicit automatic origins and keeps NULL rows on the name fallback', () => {
    const sql = sqlStub();
    automaticToolInvocationPredicate(sql as never, 'ti');
    const call = sql.calls[0];
    const values = call.values.flatMap((value) => Array.isArray(value) ? value : [value]);

    expect(call.strings.join(' ')).toContain('IS NULL');
    expect(values).toEqual(expect.arrayContaining(['ti.call_origin', 'ti.tool_name', ...AUTOMATIC_CALL_ORIGINS, ...AUTOMATIC_TOOL_NAMES]));
  });

  it('uses explicit agent origins and keeps legacy non-automatic names', () => {
    const sql = sqlStub();
    agentToolInvocationPredicate(sql as never, 'ti');
    const call = sql.calls[0];
    const values = call.values.flatMap((value) => Array.isArray(value) ? value : [value]);

    expect(call.strings.join(' ')).toContain('<> ALL');
    expect(values).toEqual(expect.arrayContaining(['ti.call_origin', 'ti.tool_name', ...AGENT_CALL_ORIGINS, ...AUTOMATIC_TOOL_NAMES]));
  });

  it('P-012: the wrapper-exclusion fragment keeps NULL/absent metadata and targets the shared key', () => {
    const sql = sqlStub();
    dispatchWrapperExclusionPredicate(sql as never, 'ti');
    const call = sql.calls[0];
    expect(call.strings.join(' ')).toContain('NOT coalesce');
    expect(call.values).toEqual(expect.arrayContaining(['ti.metadata_json', DISPATCH_WRAPPER_METADATA_KEY]));
    // The raw-string twin (for template-literal SQL constants) must express the SAME
    // predicate over the SAME key — the two forms drifting is the failure this pins.
    expect(DISPATCH_WRAPPER_EXCLUSION_SQL).toContain('NOT coalesce');
    expect(DISPATCH_WRAPPER_EXCLUSION_SQL).toContain(DISPATCH_WRAPPER_METADATA_KEY);
  });
});

/**
 * P-012 (census double-count): the row-side classifier. The literal-false and
 * truthy-but-not-true cases are the falsifiability controls — a classifier reading
 * mere key PRESENCE (or truthiness) as "wrapper" passes the first test and fails
 * those, so this suite can catch both wrong implementations.
 */
describe('isDispatchWrapperMetadata (P-012)', () => {
  it('true only for a literal dispatchWrapper: true', () => {
    expect(isDispatchWrapperMetadata({ [DISPATCH_WRAPPER_METADATA_KEY]: true })).toBe(true);
    expect(
      isDispatchWrapperMetadata({ [DISPATCH_WRAPPER_METADATA_KEY]: true, dispatchedTool: 'x' }),
    ).toBe(true);
  });

  it('false for absent / null / non-object metadata', () => {
    expect(isDispatchWrapperMetadata(null)).toBe(false);
    expect(isDispatchWrapperMetadata(undefined)).toBe(false);
    expect(isDispatchWrapperMetadata('{}')).toBe(false);
    expect(isDispatchWrapperMetadata({})).toBe(false);
  });

  it('control: presence-without-true is NOT a wrapper (a mere-presence reader fails here)', () => {
    expect(isDispatchWrapperMetadata({ [DISPATCH_WRAPPER_METADATA_KEY]: false })).toBe(false);
    expect(isDispatchWrapperMetadata({ [DISPATCH_WRAPPER_METADATA_KEY]: 'true' })).toBe(false);
    expect(isDispatchWrapperMetadata({ [DISPATCH_WRAPPER_METADATA_KEY]: 1 })).toBe(false);
  });
});
