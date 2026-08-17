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
});
