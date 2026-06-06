import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { renderWireSchemas, projectReadColumns, projectWriteColumns, type PrePromptEntry } from './index';

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (z as any).toJSONSchema(schema) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

describe('renderWireSchemas — the "## Wire schemas" legend', () => {
  const entries: PrePromptEntry[] = [
    { name: 'work_items:list', read: 'csv' },
    { name: 'work_items:set_state', read: 'off', write: 'positional' },
  ];
  const readCols = projectReadColumns(jsonSchema(z.array(z.object({ id: z.string(), state: z.enum(['todo', 'done']) }))));
  const writeCols = projectWriteColumns(jsonSchema(z.object({ id: z.string(), state: z.string(), harness: z.string().optional() })));

  it('renders read + write column lines with type tags', () => {
    const out = renderWireSchemas(entries, (e) =>
      e.name === 'work_items:list' ? { read: readCols } : { write: writeCols },
    );
    expect(out).toContain('## Wire schemas');
    expect(out).toContain('`work_items:list`');
    expect(out).toContain('read → id:id, state:todo|done');
    expect(out).toContain('`work_items:set_state`');
    expect(out).toContain('write ← id:id, state:str, harness:str?');
  });

  it('returns empty string when no tool has derivable columns', () => {
    expect(renderWireSchemas(entries, () => ({}))).toBe('');
  });
});
