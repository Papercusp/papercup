// @vitest-environment jsdom
/**
 * PlanInputsPanel.test.tsx — plan-structured-inputs-2026-08-01 P-013.
 *
 * Two layers. First the pure value rules (fieldKindOf / coerceFieldValue /
 * displayFieldValue), which is where a form quietly corrupts data: the load-bearing
 * one is that an EMPTY optional field coerces to `undefined` and is therefore OMITTED
 * from the write, not sent as `""`. The start gate tests `supplied[k] === undefined`,
 * so a blank string would satisfy a required field while meaning nothing — the plan
 * would start with an empty argument instead of being refused.
 *
 * Then the component: that it renders nothing for a plan with no schema (the common
 * case), marks required + missing fields, and surfaces the gate's own refusal hint.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const fetchPlanInputsMock = vi.fn();
const savePlanInputsMock = vi.fn(async () => ({ ok: true }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./plans-api', () => ({
  fetchPlanInputs: (...a: unknown[]) => fetchPlanInputsMock(...a),
  savePlanInputs: (...a: unknown[]) => savePlanInputsMock(...(a as [])),
}));

import PlanInputsPanel, {
  coerceFieldValue,
  displayFieldValue,
  fieldKindOf,
} from './PlanInputsPanel';

describe('fieldKindOf', () => {
  it('maps the schema slice the form renders', () => {
    expect(fieldKindOf({ type: 'string' })).toBe('string');
    expect(fieldKindOf({ type: 'number' })).toBe('number');
    expect(fieldKindOf({ type: 'integer' })).toBe('number');
    expect(fieldKindOf({ type: 'boolean' })).toBe('boolean');
    expect(fieldKindOf({ type: 'array', items: { type: 'string' } })).toBe('string-array');
  });

  it('prefers an enum over the raw type — a select beats a free-text box', () => {
    expect(fieldKindOf({ type: 'string', enum: ['a', 'b'] })).toBe('enum');
  });

  it('tolerates a nullable union type', () => {
    expect(fieldKindOf({ type: ['string', 'null'] })).toBe('string');
  });

  it('falls back to JSON for shapes the line editor would mangle', () => {
    // An array of OBJECTS through the one-per-line editor would become strings.
    expect(fieldKindOf({ type: 'array', items: { type: 'object' } })).toBe('json');
    expect(fieldKindOf({ type: 'object' })).toBe('json');
    expect(fieldKindOf(undefined)).toBe('json');
  });
});

describe('coerceFieldValue', () => {
  it('returns undefined for an empty field so an absent value stays ABSENT', () => {
    // The rule the start gate depends on — see the file header.
    expect(coerceFieldValue('string', '')).toEqual({ ok: true, value: undefined });
    expect(coerceFieldValue('string', '   ')).toEqual({ ok: true, value: undefined });
    expect(coerceFieldValue('number', '')).toEqual({ ok: true, value: undefined });
    expect(coerceFieldValue('json', '')).toEqual({ ok: true, value: undefined });
  });

  it('keeps a false boolean as a real value, never undefined', () => {
    // A boolean is always supplied — unchecked means false, not "unset".
    expect(coerceFieldValue('boolean', '', false)).toEqual({ ok: true, value: false });
    expect(coerceFieldValue('boolean', '', true)).toEqual({ ok: true, value: true });
  });

  it('parses numbers and rejects non-numeric text', () => {
    expect(coerceFieldValue('number', '42')).toEqual({ ok: true, value: 42 });
    expect(coerceFieldValue('number', '-1.5')).toEqual({ ok: true, value: -1.5 });
    const bad = coerceFieldValue('number', 'twelve');
    expect(bad.ok).toBe(false);
  });

  it('splits a string array on lines, trimming and dropping blanks', () => {
    expect(coerceFieldValue('string-array', 'packages/a\n\n  libs/b  \n')).toEqual({
      ok: true,
      value: ['packages/a', 'libs/b'],
    });
  });

  it('parses JSON and reports a parse failure rather than writing garbage', () => {
    expect(coerceFieldValue('json', '{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(coerceFieldValue('json', '{nope').ok).toBe(false);
  });

  it('preserves interior whitespace of a string it does keep', () => {
    expect(coerceFieldValue('string', 'a b')).toEqual({ ok: true, value: 'a b' });
  });
});

describe('displayFieldValue', () => {
  it('round-trips a string array through the line editor', () => {
    const shown = displayFieldValue('string-array', ['x', 'y']);
    expect(shown).toBe('x\ny');
    expect(coerceFieldValue('string-array', shown)).toEqual({ ok: true, value: ['x', 'y'] });
  });

  it('renders absent values as empty, not "undefined"/"null"', () => {
    expect(displayFieldValue('string', undefined)).toBe('');
    expect(displayFieldValue('string', null)).toBe('');
  });

  it('pretty-prints JSON so it is editable', () => {
    expect(displayFieldValue('json', { a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe('PlanInputsPanel', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const SCHEMA_INFO = {
    ok: true as const,
    slug: 'proj',
    source: 'input-schema' as const,
    inputSchema: {
      type: 'object',
      properties: {
        harness: { type: 'string', description: 'Which harness to run in.' },
        paths: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' },
      },
      required: ['harness', 'paths'],
    },
    template: null,
    required: ['harness', 'paths'],
    missing: ['paths'],
    values: { harness: 'papercusp' },
    ready: false,
    code: 'missing_required' as const,
    issues: [],
    hint: 'Required input not supplied: paths.',
  };

  it('renders nothing for a plan that declares no inputs', async () => {
    fetchPlanInputsMock.mockResolvedValue({
      ok: true,
      slug: 'proj',
      source: 'none',
      inputSchema: null,
      template: null,
      required: [],
      missing: [],
      values: null,
      ready: true,
    });
    const { container } = render(<PlanInputsPanel slug="proj" />);
    await waitFor(() => expect(fetchPlanInputsMock).toHaveBeenCalled());
    expect(container.querySelector('.pc-plan-inputs')).toBeNull();
  });

  it('renders a field per declared property, seeded with current values', async () => {
    fetchPlanInputsMock.mockResolvedValue(SCHEMA_INFO);
    render(<PlanInputsPanel slug="proj" />);
    const harness = await screen.findByLabelText(/harness/i);
    expect((harness as HTMLInputElement).value).toBe('papercusp');
    expect(screen.getByText('Which harness to run in.')).toBeTruthy();
    // The boolean gets a checkbox, the array a textarea.
    expect((await screen.findByLabelText(/dryRun/i)).getAttribute('type')).toBe('checkbox');
  });

  it('surfaces the gate\'s own refusal hint and flags the missing field', async () => {
    fetchPlanInputsMock.mockResolvedValue(SCHEMA_INFO);
    const { container } = render(<PlanInputsPanel slug="proj" />);
    await screen.findByText('Required input not supplied: paths.');
    expect(screen.getByText(/1 required missing/)).toBeTruthy();
    // `paths` is missing; `harness` is required but supplied — only one is flagged.
    expect(container.querySelectorAll('.pc-plan-inputs__field--missing')).toHaveLength(1);
  });

  it('shows a ready badge once the gate would admit the plan', async () => {
    fetchPlanInputsMock.mockResolvedValue({
      ...SCHEMA_INFO,
      missing: [],
      values: { harness: 'papercusp', paths: ['a'] },
      ready: true,
      code: undefined,
      hint: undefined,
    });
    render(<PlanInputsPanel slug="proj" />);
    expect(await screen.findByText('ready to start')).toBeTruthy();
  });

  it('explains rather than renders an empty form for a code-registry template plan', async () => {
    fetchPlanInputsMock.mockResolvedValue({
      ok: true,
      slug: 'proj',
      source: 'template',
      inputSchema: null,
      template: 'rubric',
      required: ['name'],
      missing: ['name'],
      values: null,
      ready: false,
      code: 'missing_required',
      issues: [],
      hint: 'Required input not supplied: name.',
    });
    render(<PlanInputsPanel slug="proj" />);
    expect(await screen.findByText(/defined in code/)).toBeTruthy();
    expect(screen.getByText('Required input not supplied: name.')).toBeTruthy();
  });
});
