import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';

import { readOrientationToolSurfaces } from './turn-start-orientation';
import {
  AGENT_CALL_ORIGINS,
  AUTOMATIC_TOOL_NAMES,
} from './agent-tools/sessions/automatic-tool-names';

type SqlFragment = { kind: 'fragment'; strings: readonly string[]; values: unknown[] };
type SqlCall = { strings: readonly string[]; values: unknown[] };
type SqlStub = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> | SqlFragment) & {
  calls: SqlCall[];
  unsafe(identifier: string): string;
  array(values: unknown[]): unknown[];
};

function sqlStub(rows: unknown[] = []): SqlStub {
  const calls: SqlCall[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = { strings: [...strings], values };
    calls.push(call);
    return strings.join('').includes('WITH anchors')
      ? Promise.resolve(rows)
      : { kind: 'fragment' as const, ...call };
  }) as SqlStub;
  sql.calls = calls;
  sql.unsafe = (identifier) => identifier;
  sql.array = (values) => values;
  return sql;
}

function flattenSqlPart(part: unknown): unknown[] {
  if (Array.isArray(part)) return part.flatMap(flattenSqlPart);
  if (part && typeof part === 'object' && 'kind' in part && part.kind === 'fragment') {
    const fragment = part as SqlFragment;
    return [...fragment.strings, ...fragment.values.flatMap(flattenSqlPart)];
  }
  return [part];
}

describe('readOrientationToolSurfaces', () => {
  it('uses the shared agent-origin predicate, including unknown and legacy NULL calls', async () => {
    const sql = sqlStub();

    expect(await readOrientationToolSurfaces(sql as unknown as Sql, ['su-owner'])).toEqual([]);

    const query = sql.calls.find((call) => call.strings.join('').includes('WITH anchors'));
    expect(query).toBeDefined();
    expect(query!.strings.join('')).toContain('NOT EXISTS');

    const boundValues = query!.values.flatMap(flattenSqlPart);
    expect(boundValues).toEqual(expect.arrayContaining([
      't.call_origin',
      't.tool_name',
      ...AGENT_CALL_ORIGINS,
      ...AUTOMATIC_TOOL_NAMES,
    ]));
  });
});
