import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import assertTool from './assert';

const base = {
  scope: 'owner',
  key: 'schema-probe',
  body: 'schema probe',
};

describe('facts:assert settledBy modality contract', () => {
  it('accepts settledBy only on an undecidable fact and requires it there', () => {
    expect(
      assertTool.args.safeParse({
        ...base,
        kind: 'undecidable',
        settledBy: 'a concrete validation probe',
      }).success,
    ).toBe(true);
    expect(assertTool.args.safeParse({ ...base, kind: 'undecidable' }).success).toBe(false);
  });

  it('rejects settledBy on a conclusion, assumption, convention, or undeclared modality', () => {
    for (const kind of ['conclusion', 'assumption', 'convention', undefined]) {
      expect(
        assertTool.args.safeParse({
          ...base,
          ...(kind ? { kind } : {}),
          settledBy: 'a probe that would settle an open question',
        }).success,
        `kind=${kind ?? 'omitted'}`,
      ).toBe(false);
    }
    expect(assertTool.args.safeParse({ ...base }).success).toBe(true);
    expect(assertTool.args.safeParse({ ...base, kind: 'conclusion' }).success).toBe(true);
  });

  it('publishes the conditional relationship as two JSON-schema branches', () => {
    const json = z.toJSONSchema(assertTool.args as never) as {
      anyOf?: Array<{
        required?: string[];
        properties?: Record<string, { const?: unknown; enum?: unknown[]; not?: unknown }>;
      }>;
      oneOf?: Array<{
        required?: string[];
        properties?: Record<string, { const?: unknown; enum?: unknown[]; not?: unknown }>;
      }>;
    };
    const branches = json.anyOf ?? json.oneOf ?? [];
    expect(branches).toHaveLength(2);

    const undecidable = branches.find((branch) => branch.properties?.kind?.const === 'undecidable');
    const other = branches.find((branch) => branch.properties?.kind?.enum?.includes('conclusion'));
    expect(undecidable?.required).toContain('settledBy');
    expect(other?.required ?? []).not.toContain('settledBy');
    expect(other?.properties?.settledBy).toMatchObject({ not: expect.anything() });
  });
});
