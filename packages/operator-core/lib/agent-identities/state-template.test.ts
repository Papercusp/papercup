import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateIdentityStateTemplate, type IdentityTemplateCellReader } from './state-template';
import type { CellRead } from '../cell-read';

const value = (cell: string, value: unknown): CellRead => ({ status: 'value', cell, value, headline: 'value', resolver: 'test' });
const definition = { template: 'Count: {{ status.count }}; ready: {{ status.ready }}', cells: { status: { cell: 'test.status' } } };
const options = (readCell: IdentityTemplateCellReader, overrides: Record<string, unknown> = {}) => ({
  readCell, signal: new AbortController().signal, timeoutMs: 500, maxBytes: 4_096, ...overrides,
});
afterEach(() => vi.useRealTimers());

describe('identity state templates', () => {
  it('renders measured zero/false, deduplicates aliases, and measures again next invocation', async () => {
    const read = vi.fn<IdentityTemplateCellReader>().mockResolvedValue(value('test.status', { count: 0, ready: false }));
    const input = { ...definition, template: definition.template + '; again: {{ duplicate.count }}',
      cells: { ...definition.cells, duplicate: { cell: 'test.status' }, unused: { cell: 'test.unused' } } };
    const first = await evaluateIdentityStateTemplate(input, options(read));
    expect(first).toMatchObject({ status: 'value', text: 'Count: 0; ready: false; again: 0', reads: [{ cell: 'test.status', status: 'value' }] });
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(value('test.status', { count: 2, ready: true }));
    const second = await evaluateIdentityStateTemplate(input, options(read));
    expect(second).toMatchObject({ status: 'value', text: 'Count: 2; ready: true; again: 2' });
    expect(read).toHaveBeenCalledTimes(2);
    if (first.status === 'value' && second.status === 'value') expect(second.contentHash).not.toBe(first.contentHash);
  });

  it('preserves null, arrays, subjects and literal template-looking values', async () => {
    const read = vi.fn<IdentityTemplateCellReader>().mockImplementation(async ({ cell }) => value(cell, { absent: null, items: ['{{ secret.value }}'] }));
    expect(await evaluateIdentityStateTemplate({
      template: '{{ source.absent }} / {{ source.items }} / {{ source.items.0 }}',
      cells: { source: { cell: 'test.status', subject: 'wearer-1' } },
    }, options(read))).toMatchObject({ status: 'value', text: 'null / ["{{ secret.value }}"] / {{ secret.value }}' });
    expect(read.mock.calls[0]![0]).toEqual({ cell: 'test.status', subject: 'wearer-1' });
  });

  it.each([
    '{{ status.missing }}', '{{ status.toString }}',
  ])('omits missing own paths rather than replacing them with empty text: %s', async (template) => {
    expect(await evaluateIdentityStateTemplate({ ...definition, template }, options(async () => value('test.status', {}))))
      .toMatchObject({ status: 'omitted', reason: 'unavailable' });
  });

  it.each([
    '{{ secret.value }}', '{{ status.constructor.name }}', '{{ status.__proto__ }}',
    '{{ status.count + 1 }}', '{{ status.count }', '{{{ status.count }}}', 'static text',
  ])('refuses malformed or undeclared expressions before any read: %s', async (template) => {
    const read = vi.fn<IdentityTemplateCellReader>();
    expect(await evaluateIdentityStateTemplate({ ...definition, template }, options(read)))
      .toEqual({ status: 'omitted', reason: 'invalid-template', reads: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['not-measured', 'resolver-failed', 'insufficient-data', 'not-applicable'] as const)(
    'preserves unknown %s without generating a success value', async (code) => {
      expect(await evaluateIdentityStateTemplate(definition, options(async () => ({
        status: 'unknown', cell: 'test.status', unknown: { code },
      })))).toEqual({ status: 'omitted', reason: 'unavailable', reads: [{ cell: 'test.status', status: 'unknown', unknownCode: code }] });
    },
  );

  it('keeps absent cells absent and catches reader failure', async () => {
    expect(await evaluateIdentityStateTemplate(definition, options(async () => ({ status: 'absent', cell: 'test.status' }))))
      .toEqual({ status: 'omitted', reason: 'unavailable', reads: [{ cell: 'test.status', status: 'absent' }] });
    expect(await evaluateIdentityStateTemplate(definition, options(async () => { throw new Error('unavailable'); })))
      .toMatchObject({ status: 'omitted', reason: 'unavailable', reads: [{ unknownCode: 'resolver-failed' }] });
  });

  it('does not accept a response for another cell', async () => {
    expect(await evaluateIdentityStateTemplate(definition, options(async () => value('other.cell', { count: 4, ready: true }))))
      .toMatchObject({ status: 'omitted', reason: 'unavailable' });
  });

  it.each([NaN, Infinity, undefined, { count: undefined }])('refuses non-JSON measurements rather than converting them to null: %s', async (measured) => {
    expect(await evaluateIdentityStateTemplate({ template: '{{ status }}', cells: definition.cells }, options(async () => value('test.status', measured))))
      .toMatchObject({ status: 'omitted', reason: 'unavailable' });
  });

  it('bounds aggregate measured bytes and expanded output bytes', async () => {
    const input = { template: '{{ a }}{{ b }}', cells: { a: { cell: 'a' }, b: { cell: 'b' } } };
    expect(await evaluateIdentityStateTemplate(input, options(async ({ cell }) => value(cell, 'abcdef'), { maxBytes: 12 })))
      .toMatchObject({ status: 'omitted', reason: 'output-too-large' });
    expect(await evaluateIdentityStateTemplate({ ...input, template: '{{ a }}{{ a }}{{ a }}' }, options(async ({ cell }) => value(cell, 'abcdef'), { maxBytes: 12 })))
      .toMatchObject({ status: 'omitted', reason: 'output-too-large' });
  });

  it('propagates cancellation and fences late successful values', async () => {
    const parent = new AbortController();
    let finish!: (result: CellRead) => void;
    let signal!: AbortSignal;
    const read: IdentityTemplateCellReader = (_ref, given) => {
      signal = given;
      return new Promise((resolve) => { finish = resolve; });
    };
    const pending = evaluateIdentityStateTemplate(definition, options(read, { signal: parent.signal }));
    parent.abort();
    expect(signal.aborted).toBe(true);
    const result = await pending;
    expect(result).toEqual({ status: 'omitted', reason: 'cancelled', reads: [] });
    finish(value('test.status', { count: 3, ready: true }));
    await Promise.resolve();
    expect(result).toEqual({ status: 'omitted', reason: 'cancelled', reads: [] });
  });

  it('times out a noncooperative reader and cancels its signal', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const pending = evaluateIdentityStateTemplate(definition, options((_ref, given) => {
      signal = given;
      return new Promise(() => {});
    }, { timeoutMs: 50 }));
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual({ status: 'omitted', reason: 'deadline', reads: [] });
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs at most four reads at once and stops queued reads after cancellation', async () => {
    const parent = new AbortController();
    const completions: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const read = vi.fn<IdentityTemplateCellReader>(({ cell }) => new Promise((resolve) => {
      active++;
      peak = Math.max(peak, active);
      completions.push(() => { active--; resolve(value(cell, true)); });
    }));
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const pending = evaluateIdentityStateTemplate({
      template: names.map((name) => '{{ ' + name + ' }}').join(' '),
      cells: Object.fromEntries(names.map((name) => [name, { cell: name }])),
    }, options(read, { signal: parent.signal }));
    expect(read).toHaveBeenCalledTimes(4);
    completions[0]!();
    await Promise.resolve(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(5);
    expect(peak).toBe(4);
    parent.abort();
    expect(await pending).toMatchObject({ status: 'omitted', reason: 'cancelled' });
    for (const complete of completions.slice(1)) complete();
    await Promise.resolve(); await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(5);
  });

  it('does no reads for an already cancelled invocation or invalid budgets', async () => {
    const read = vi.fn<IdentityTemplateCellReader>();
    const parent = new AbortController(); parent.abort();
    expect(await evaluateIdentityStateTemplate(definition, options(read, { signal: parent.signal })))
      .toMatchObject({ status: 'omitted', reason: 'cancelled' });
    expect(await evaluateIdentityStateTemplate(definition, options(read, { maxBytes: Infinity })))
      .toMatchObject({ status: 'omitted', reason: 'invalid-template' });
    expect(read).not.toHaveBeenCalled();
  });
});
