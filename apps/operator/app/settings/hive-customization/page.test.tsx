// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

const render = (ui: ReactElement) => rtlRender(<NuqsTestingAdapter searchParams="">{ui}</NuqsTestingAdapter>);

/* ── Mocks ─────────────────────────────────────────────────────────── */

const mutateMock = vi.fn(async () => ({ ok: true }));
// queryName-aware sync mock: the hive picker reads `learning.hiveList`, the editors
// read `hive.overrides`.
let hiveList: unknown[] = [];
let overrideRows: unknown[] = [];
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts?: { queryName?: string }) =>
    opts?.queryName === 'learning.hiveList'
      ? { data: hiveList, loading: false, error: null }
      : { data: overrideRows, loading: false, error: null },
  useSyncMutate: () => mutateMock,
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

// Self-contained nuqs stand-in (useState-backed), seeded per-test from `initialParams`
// so a test can render with a hive already selected without driving the Radix Select.
let initialParams: Record<string, string> = {};
vi.mock('nuqs', async () => {
  const React = await import('react');
  const builder = (def: unknown) => ({ __default: def, withDefault: (d: unknown) => ({ __default: d }) });
  return {
    parseAsString: builder(null),
    // HivePolicyPanel uses parseAsBoolean.withDefault(false) for the 'hivePolicy'
    // panel-open URL state — the mock must export it or the panel render throws.
    parseAsBoolean: builder(false),
    useQueryState: (key: string, parser?: { __default?: unknown }) => {
      const [v, setV] = React.useState<unknown>(initialParams[key] ?? parser?.__default ?? null);
      return [v, (next: unknown) => { setV(next); return Promise.resolve(true); }];
    },
  };
});

import HiveCustomizationPage from './page';

beforeEach(() => {
  mutateMock.mockClear();
  hiveList = [{ slug: 'acme-hive', remote: false }];
  overrideRows = [];
  initialParams = {};
});
afterEach(cleanup);

describe('HiveCustomizationPage', () => {
  it('prompts to pick a hive when none is selected', () => {
    render(<HiveCustomizationPage />);
    expect(screen.getByText(/Pick a hive to edit/i)).toBeTruthy();
    // No editor sections until a hive is chosen.
    expect(screen.queryByText('Role persona (prose)')).toBeNull();
  });

  it('shows both editors once a hive is selected', () => {
    initialParams = { hive: 'acme-hive' };
    render(<HiveCustomizationPage />);
    expect(screen.getByText('Role persona (prose)')).toBeTruthy();
    expect(screen.getByText('Structured config')).toBeTruthy();
    // The prose editor's textarea is present (role defaults to su).
    expect(screen.getByPlaceholderText(/Markdown delta appended/i)).toBeTruthy();
  });

  it('seeds the prose editor from an existing promptOverride row', () => {
    initialParams = { hive: 'acme-hive' };
    overrideRows = [{ kind: 'prompt', name: 'su', value: 'be terse' }];
    render(<HiveCustomizationPage />);
    const textarea = screen.getByPlaceholderText(/Markdown delta appended/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe('be terse');
  });

  it('writes a prose override through the mutate hook with the right args', () => {
    initialParams = { hive: 'acme-hive' };
    render(<HiveCustomizationPage />);
    const textarea = screen.getByPlaceholderText(/Markdown delta appended/i);
    fireEvent.change(textarea, { target: { value: 'domain delta' } });
    fireEvent.click(screen.getByRole('button', { name: /Save override/i }));
    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0]![0]).toMatchObject({
      hiveSlug: 'acme-hive',
      kind: 'prompt',
      name: 'su',
      value: 'domain delta',
    });
  });

  it('writes a structured scout config through the mutate hook as an object', () => {
    initialParams = { hive: 'acme-hive' };
    render(<HiveCustomizationPage />);
    const cfg = screen.getByPlaceholderText(/"lenses"/);
    fireEvent.change(cfg, { target: { value: '{"buckets":{"maxMoonshots":2}}' } });
    fireEvent.click(screen.getByRole('button', { name: /Save config/i }));
    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0]![0]).toMatchObject({
      hiveSlug: 'acme-hive',
      kind: 'config',
      name: 'scout',
      value: { buckets: { maxMoonshots: 2 } },
    });
  });

  it('disables Save config and shows an error on invalid JSON', () => {
    initialParams = { hive: 'acme-hive' };
    render(<HiveCustomizationPage />);
    const cfg = screen.getByPlaceholderText(/"lenses"/);
    fireEvent.change(cfg, { target: { value: '{ not json' } });
    expect(screen.getByText(/Invalid JSON/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Save config/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('rejects a non-object JSON value (array) for the config editor', () => {
    initialParams = { hive: 'acme-hive' };
    render(<HiveCustomizationPage />);
    const cfg = screen.getByPlaceholderText(/"lenses"/);
    fireEvent.change(cfg, { target: { value: '[1,2,3]' } });
    expect(screen.getByText(/Must be a JSON object/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Save config/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
