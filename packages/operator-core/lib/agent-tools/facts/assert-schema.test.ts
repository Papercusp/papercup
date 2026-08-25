import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import assertTool from './assert';
import { FACT_MAX_SUPERSEDES } from '../../agent-facts/store';

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
        anyOf?: unknown[];
        oneOf?: unknown[];
      }>;
      oneOf?: Array<{
        required?: string[];
        properties?: Record<string, { const?: unknown; enum?: unknown[]; not?: unknown }>;
        anyOf?: unknown[];
        oneOf?: unknown[];
      }>;
    };
    const unionLeaves = (node: {
      anyOf?: Array<unknown>;
      oneOf?: Array<unknown>;
    }): Array<{ required?: string[]; properties?: Record<string, { const?: unknown; enum?: unknown[]; not?: unknown }> }> => {
      const nested = node.anyOf ?? node.oneOf;
      if (!nested) return [node as { required?: string[]; properties?: Record<string, { const?: unknown; enum?: unknown[]; not?: unknown }> }];
      return nested.flatMap((branch) => unionLeaves(branch as { anyOf?: Array<unknown>; oneOf?: Array<unknown> }));
    };
    const branches = unionLeaves(json);

    const undecidable = branches.find((branch) => branch.properties?.kind?.const === 'undecidable');
    const other = branches.find((branch) => branch.properties?.kind?.enum?.includes('conclusion'));
    expect(undecidable?.required).toContain('settledBy');
    expect(other?.required ?? []).not.toContain('settledBy');
    expect(other?.properties?.settledBy).toMatchObject({ not: expect.anything() });
  });
});

describe('facts:assert shareable federation contract', () => {
  it('requires a federation harness, while preserving explicit harness scopeRef', () => {
    expect(assertTool.args.safeParse({ ...base, shareable: true }).success).toBe(false);
    expect(assertTool.args.safeParse({ ...base, shareable: true, harness: 'papercusp' }).success).toBe(true);
    expect(
      assertTool.args.safeParse({
        ...base,
        scope: 'harness',
        scopeRef: 'papercusp',
        shareable: true,
      }).success,
    ).toBe(true);
    expect(assertTool.args.safeParse({ ...base, shareable: false }).success).toBe(true);
  });

  it('publishes the shareable discriminator and harness prerequisite', () => {
    const json = JSON.stringify(z.toJSONSchema(assertTool.args as never));
    expect(json).toContain('shareable');
    expect(json).toContain('Concrete federation harness required');
    expect(json).toContain('const":true');
  });
});

describe('facts:assert supersedes contract', () => {
  it('publishes a bounded sibling-key list on every modality branch', () => {
    expect(
      assertTool.args.safeParse({
        ...base,
        supersedes: Array.from({ length: FACT_MAX_SUPERSEDES }, (_, i) => `old-${i}`),
      }).success,
    ).toBe(true);
    expect(
      assertTool.args.safeParse({
        ...base,
        supersedes: Array.from({ length: FACT_MAX_SUPERSEDES + 1 }, (_, i) => `old-${i}`),
      }).success,
    ).toBe(false);
    expect(assertTool.args.safeParse({ ...base, supersedes: [''] }).success).toBe(false);
  });

  it('documents same-scope atomic retirement and the actual-change receipt', () => {
    const json = JSON.stringify(z.toJSONSchema(assertTool.args as never));
    expect(json).toContain('supersedes');
    expect(json).toContain('SAME workspace/scope/ref');
    expect(json).toContain('receipt reports the keys actually retired');
  });
});

describe('facts:assert cap-admission contract', () => {
  it('documents refusal of destructive cross-author verified eviction and exempt slots', () => {
    const options = (assertTool.args as unknown as { options: Array<{ shape: Record<string, unknown> }> }).options;
    const dryRun = options
      .map((option) => option.shape.dryRun as { description?: string } | undefined)
      .find(Boolean)?.description;

    expect(dryRun).toMatch(/refused before write/i);
    expect(dryRun).toMatch(/another author.*verified fact/i);
    expect(dryRun).toMatch(/conventions and typed safety slots take no cap seat/i);
  });
});
