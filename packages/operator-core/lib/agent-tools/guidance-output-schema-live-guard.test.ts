/**
 * EI-21111131926207175 — keep response-shape guidance derived from registered
 * output schemas instead of letting prose become a second, unverifiable type
 * system.
 *
 * The live census is intentionally strict: a tool that authors
 * `guidance.returns` must also declare `result`, which projects to
 * `outputJsonSchema`. Two directional checks then keep the public contract
 * honest:
 *
 *  1. top-level field tokens in the first authored `{ ... }` shape clause
 *     must resolve to top-level properties in the registered schema;
 *  2. every top-level registered property must survive the compact shape
 *     rendered by tools:find.
 *
 * Behavioural interpretation remains useful prose. Only the structural clause
 * is parsed, so sentences about nullability, provenance, or operator action do
 * not become another hand-maintained schema.
 */
import { describe, expect, it } from 'vitest';

import './index';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { compactOutputSchemaForResult } from './tools/find';

type JsonSchema = Record<string, unknown>;
type CatalogTool = {
  expose?: { mcp?: { name?: string } };
  guidance?: { returns?: string };
  outputJsonSchema?: JsonSchema;
};

export interface ReturnSchemaViolation {
  tool: string;
  kind: 'missing-output-schema' | 'promised-field-missing' | 'generated-clause-omission';
  fields: string[];
}

function firstBalancedShapeClause(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

/** Top-level field names from the first authored shape clause. */
export function structuralReturnFields(returns: unknown): string[] {
  if (typeof returns !== 'string') return [];
  const clause = firstBalancedShapeClause(returns);
  if (!clause) return [];

  const fields = new Set<string>();
  let segment = '';
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const flush = () => {
    const match = segment.trim().match(/^([A-Za-z_$][\w$-]*)(?:\?|\[\])?/);
    if (match) fields.add(match[1]!);
    segment = '';
  };

  for (const char of clause.slice(1, -1)) {
    if (quote) {
      segment += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      segment += char;
      continue;
    }
    if (char === '{') {
      if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) flush();
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth > 0) continue;
    if (char === '[') {
      if (bracketDepth === 0 && parenDepth === 0) flush();
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (bracketDepth > 0) continue;
    if (char === '(') {
      if (parenDepth === 0) flush();
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (parenDepth > 0) continue;
    if (parenDepth === 0 && (char === ',' || char === ';')) {
      flush();
      continue;
    }
    segment += char;
  }
  flush();
  return [...fields];
}

function topLevelSchemaFields(schema: JsonSchema): string[] {
  const properties = schema.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties as JsonSchema)
    : [];
}

function renderedFieldNames(rendered: string): Set<string> {
  return new Set([...rendered.matchAll(/(?:^|;\s)([A-Za-z_$][\w$-]*)(?:\?)?(?=[:;]|$)/g)].map((match) => match[1]!));
}

export function returnSchemaViolations(
  tools: readonly CatalogTool[],
  render: (schema: JsonSchema) => string | null = compactOutputSchemaForResult,
): ReturnSchemaViolation[] {
  const violations: ReturnSchemaViolation[] = [];
  for (const tool of tools) {
    const returns = tool.guidance?.returns?.trim();
    if (!returns) continue;
    const name = tool.expose?.mcp?.name ?? '<unnamed-tool>';
    const schema = tool.outputJsonSchema;
    if (!schema) {
      violations.push({ tool: name, kind: 'missing-output-schema', fields: structuralReturnFields(returns) });
      continue;
    }

    const schemaFields = new Set(topLevelSchemaFields(schema));
    const promisedMissing = structuralReturnFields(returns).filter((field) => !schemaFields.has(field));
    if (promisedMissing.length > 0) {
      violations.push({ tool: name, kind: 'promised-field-missing', fields: promisedMissing });
    }

    const rendered = render(schema);
    const renderedFields = rendered ? renderedFieldNames(rendered) : new Set<string>();
    const generatedMissing = topLevelSchemaFields(schema).filter((field) => !renderedFields.has(field));
    if (generatedMissing.length > 0) {
      violations.push({ tool: name, kind: 'generated-clause-omission', fields: generatedMissing });
    }
  }
  return violations;
}

function namedTool(name: string): CatalogTool {
  const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === name);
  if (!tool) throw new Error(`fixture tool not registered: ${name}`);
  return tool as CatalogTool;
}

describe('guidance return shapes resolve through registered output schemas', () => {
  it('reads the real catalog rather than passing vacuously', () => {
    expect(listAllProjectedTools().length).toBeGreaterThanOrEqual(500);
  });

  it('catches guidance → schema drift on the processes:list positive control', () => {
    const processList = namedTool('processes:list');
    expect(returnSchemaViolations([processList])).toEqual([]);
    const properties = { ...((processList.outputJsonSchema!.properties ?? {}) as JsonSchema) };
    delete properties.counts;
    const mutated = { ...processList, outputJsonSchema: { ...processList.outputJsonSchema!, properties } };
    expect(returnSchemaViolations([mutated])).toContainEqual({
      tool: 'processes:list',
      kind: 'promised-field-missing',
      fields: ['counts'],
    });
  });

  it('catches schema → generated-clause drift on the sessions:read positive control', () => {
    const sessionRead = namedTool('sessions:read');
    expect(returnSchemaViolations([sessionRead])).toEqual([]);
    const schema = {
      ...sessionRead.outputJsonSchema!,
      properties: {
        ...((sessionRead.outputJsonSchema!.properties ?? {}) as JsonSchema),
        loadBearingSentinel: { type: 'string' },
      },
    };
    const mutated = { ...sessionRead, outputJsonSchema: schema };
    expect(returnSchemaViolations([mutated], (value) => compactOutputSchemaForResult(value)?.replace(/; loadBearingSentinel[^;]*/, '') ?? null))
      .toContainEqual({
        tool: 'sessions:read',
        kind: 'generated-clause-omission',
        fields: ['loadBearingSentinel'],
      });
  });

  it('every authored returns contract is backed by a registered, resolvable schema', () => {
    const violations = returnSchemaViolations(listAllProjectedTools() as readonly CatalogTool[]);
    expect(
      violations.map(({ tool, kind, fields }) => `${tool}: ${kind}${fields.length ? ` (${fields.join(', ')})` : ''}`),
      'guidance.returns prose may interpret a result, but its structural shape must come from outputJsonSchema',
    ).toEqual([]);
  });
});
