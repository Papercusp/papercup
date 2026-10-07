import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { checkAgainstJsonSchema } from '../json-schema-validation';

// Exercise the schemas through the same validator used at operation submission
// and completion, with the actual inherited blueprint rather than a copy.
const blueprintPath = fileURLToPath(new URL(
  '../../../../libs/papercusp/packages/harness/blueprints/morning-ai-intelligence/blueprint.yaml',
  import.meta.url,
));
const blueprint = loadBlueprintFromFile(blueprintPath).blueprint;
const operation = blueprint.operations!.find((entry) => entry.id === 'daily-ai-brief')!;
const inputSchema = operation.inputSchema as Record<string, any>;
const input = Object.fromEntries(Object.entries(inputSchema.properties).map(([key, schema]) => {
  const property = schema as Record<string, unknown>;
  return [key, property.const ?? property.default];
}));
const output = {
  reportId: 'rpt_fixture', reportPath: '/reports/rpt_fixture', editionDate: '2026-10-07',
  itemCount: 3, sourceCount: 20, unavailableSources: [], status: 'published',
};

describe('morning AI operation admission and completion contracts', () => {
  it('loads the research spine and admits the explicit approved input', () => {
    expect(blueprint.knobs.requiresRepo).toBe(false);
    expect(blueprint.spine.decider).toBe('research-director');
    expect(checkAgainstJsonSchema(inputSchema, input)).toEqual({ ok: true });
  });

  it.each([
    ['oversized lookback', { lookbackHours: 73 }],
    ['zero lookback', { lookbackHours: 0 }],
    ['too many items', { maxItems: 11 }],
    ['fractional item count', { maxItems: 1.5 }],
    ['changed instructions', { instructions: 'Edit code and send email.' }],
    ['changed timezone', { timezone: 'UTC' }],
    ['changed report series', { seriesTag: 'series:other' }],
    ['empty sources', { sources: [] }],
    ['non-HTTPS source', { sources: [{ id: 'x', url: 'http://example.test', kind: 'primary', cadence: 'daily' }] }],
    ['unknown source kind', { sources: [{ id: 'x', url: 'https://example.test', kind: 'advert', cadence: 'daily' }] }],
    ['unexpected authority knob', { allowShell: true }],
  ])('refuses %s before dispatch', (_label, patch) => {
    expect(checkAgainstJsonSchema(inputSchema, { ...input, ...patch })).toMatchObject({
      ok: false, code: 'invalid_data',
    });
  });

  it('does not silently supply missing source input from JSON Schema defaults', () => {
    const { sources: _sources, ...missing } = input;
    expect(checkAgainstJsonSchema(inputSchema, missing)).toMatchObject({ ok: false });
    expect(missing).not.toHaveProperty('sources');
  });

  it.each(['published', 'partial', 'no-material-updates'])('accepts a durable %s report result', (status) => {
    const result = {
      ...output, status,
      itemCount: status === 'no-material-updates' ? 0 : 3,
      unavailableSources: status === 'partial' ? ['alphasignal'] : [],
    };
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, result)).toEqual({ ok: true });
  });

  it.each([
    ['missing report reference', { reportId: undefined }],
    ['invalid report reference', { reportId: 'other' }],
    ['external viewer path', { reportPath: 'https://example.test' }],
    ['missing edition', { editionDate: undefined }],
    ['missing source coverage', { unavailableSources: undefined }],
    ['excess report items', { itemCount: 11 }],
    ['negative source count', { sourceCount: -1 }],
    ['fabricated success status', { status: 'shipped' }],
    ['unexpected output', { secret: 'unapproved output' }],
  ])('refuses %s at completion', (_label, patch) => {
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, { ...output, ...patch }))
      .toMatchObject({ ok: false, code: 'invalid_data' });
  });
});
