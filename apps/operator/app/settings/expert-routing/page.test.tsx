// @vitest-environment jsdom
/**
 * /settings/expert-routing — consult expert-routing owner surface render test
 * (consult-expert-routing-2026-09-22 P-006).
 *
 * Pins the contracts that carry the plan's Decisions into the UI, rather than
 * the styling:
 *   - ORDER IS THE POLICY (D-004): the list renders in rank order with
 *     positional badges, reorder/remove renumber densely, and the SAVE payload
 *     carries the order as array position with no rank field — one
 *     representation of the walk order on the wire, never two that can disagree.
 *   - An empty list BLOCKS the save and says why. The store replaces an empty
 *     allowlist with the seed, so a naive page would let the owner clear the
 *     list, save, and watch the default policy reappear as if the edit was lost.
 *   - Half-life BOUNDS come from the server payload (the module that owns
 *     MIN/MAX), so the page cannot drift from 0.5/365.
 *   - A stored full model ID the canonical menu does not know (the seed's `gpt-6-astra`) still
 *     renders and survives a save — the launcher's accepted id set is open.
 *   - A pair already ranked is DISABLED in the picker, matching the normalizer's
 *     (agent, model) dedupe: the UI must not offer what the store would drop.
 *
 * Seams: @papercusp/sync + nuqs + sonner are module-mocked, and the Radix-backed
 * harness Select becomes a native stand-in (this is a page test, not a Select
 * test). Real pointer/Radix mechanics belong to the Tauri e2e surface.
 *
 * No jest-dom matchers — this workspace's vitest setup does not register that
 * Chai plugin (same note as harness/__tests__/Combobox.test.tsx and
 * adv/sessions/NewSessionLauncher.test.tsx), so `toBeDisabled()` /
 * `toBeInTheDocument()` would throw `Invalid Chai property` rather than fail
 * honestly. Assert on the DOM property, and lean on getBy* throwing on absence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  row: undefined as unknown,
  error: null as Error | null,
  loading: false,
  invalidate: vi.fn(),
  mutate: vi.fn(async (_args: unknown) => ({ ok: true })),
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({
    data: h.row,
    error: h.error,
    loading: h.loading,
    fetching: false,
    invalidate: h.invalidate,
  }),
  useSyncMutate: () => h.mutate,
}));

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => {
  const withDefault = (d: unknown) => ({ defaultValue: d });
  return {
    ...nuqsParsers,
    parseAsBoolean: { withDefault },
    parseAsString: { withDefault },
    parseAsStringEnum: () => ({ withDefault }),
    useQueryState: (_key: string, parser?: { defaultValue?: unknown }) => {
      const React = require('react') as typeof import('react');
      return React.useState<unknown>(parser?.defaultValue ?? null);
    },
  };
});

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

/* Radix Select → native stand-in. Flattens groups to <optgroup> and KEEPS
 * `disabled`, because the dedupe assertion below reads it. */
interface MockOption {
  value: string;
  label: string;
  disabled?: boolean;
}
type MockEntry = MockOption | { kind: 'group'; label: string; options: MockOption[] };
vi.mock('../../harness/Select', () => ({
  Select: ({
    value,
    onChange,
    ariaLabel,
    options,
  }: {
    value: string;
    onChange: (v: string) => void;
    ariaLabel: string;
    options: MockEntry[];
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((entry, i) =>
        'kind' in entry && entry.kind === 'group' ? (
          <optgroup key={`g${i}`} label={entry.label}>
            {entry.options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : (
          <option
            key={(entry as MockOption).value}
            value={(entry as MockOption).value}
            disabled={(entry as MockOption).disabled}
          >
            {(entry as MockOption).label}
          </option>
        ),
      )}
    </select>
  ),
}));

import ExpertRoutingSettingsPage from './page';

/* ── Fixtures: the shipped seed order (D-006 fable 1, opus 2, sol 3, Astra 4) ── */
/** Mirrors the page's wire entry. Spelled out rather than inferred from SEED so a
 *  fixture can exercise the third backend (`omp`) the seed happens not to use. */
type WireEntry = { rank: number; agent: 'claude' | 'codex' | 'omp'; model: string };

const SEED: WireEntry[] = [
  { rank: 1, agent: 'claude', model: 'fable' },
  { rank: 2, agent: 'claude', model: 'opus' },
  { rank: 3, agent: 'codex', model: 'sol' },
  { rank: 4, agent: 'codex', model: 'gpt-6-astra' },
];

const mkRow = (over: Partial<{ allowlist: WireEntry[]; recencyHalfLifeDays: number }> = {}) => [
  {
    allowlist: over.allowlist ?? SEED.map((e) => ({ ...e })),
    recencyHalfLifeDays: over.recencyHalfLifeDays ?? 30,
    bounds: { minRecencyHalfLifeDays: 0.5, maxRecencyHalfLifeDays: 365 },
    defaults: { allowlist: SEED.map((e) => ({ ...e })), recencyHalfLifeDays: 30 },
  },
];

/** The model spec shown on each row, in render order. */
function renderedModels(): string[] {
  return screen
    .getAllByRole('listitem')
    .map((li) => li.querySelector('code')?.textContent ?? '');
}

/** The rank badge on each row, in render order. */
function renderedRanks(): string[] {
  return screen
    .getAllByRole('listitem')
    .map((li) => li.querySelector('span')?.textContent ?? '');
}

const saveButton = () => screen.getByRole('button', { name: /save changes/i });

/** `disabled` off the element itself — see the no-jest-dom note in the header. */
const isDisabled = (el: Element | null | undefined): boolean =>
  Boolean((el as HTMLButtonElement | HTMLOptionElement | null | undefined)?.disabled);

beforeEach(() => {
  h.row = mkRow();
  h.error = null;
  h.loading = false;
  h.mutate.mockClear();
  h.mutate.mockImplementation(async () => ({ ok: true }));
});
afterEach(cleanup);

describe('/settings/expert-routing', () => {
  it('renders the ranked allowlist in walk order with positional rank badges', () => {
    render(<ExpertRoutingSettingsPage />);
    expect(renderedModels()).toEqual(['fable', 'opus', 'sol', 'gpt-6-astra']);
    expect(renderedRanks()).toEqual(['1', '2', '3', '4']);
  });

  it('keeps a full model ID the canonical alias menu does not know rather than dropping it', () => {
    render(<ExpertRoutingSettingsPage />);
    // `gpt-6-astra` is in the seed but NOT in CLOUD_MODEL_MENU; it must still render.
    expect(renderedModels()).toContain('gpt-6-astra');
  });

  it('reorders with the move controls and renumbers ranks densely', () => {
    render(<ExpertRoutingSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /move opus up/i }));
    expect(renderedModels()).toEqual(['opus', 'fable', 'sol', 'gpt-6-astra']);
    expect(renderedRanks()).toEqual(['1', '2', '3', '4']);
  });

  it('disables the move control at each end of the list', () => {
    render(<ExpertRoutingSettingsPage />);
    expect(isDisabled(screen.getByRole('button', { name: /move fable up/i }))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: /move gpt-6-astra down/i }))).toBe(true);
  });

  it('removes an entry and renumbers the remaining ranks', () => {
    render(<ExpertRoutingSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /remove opus/i }));
    expect(renderedModels()).toEqual(['fable', 'sol', 'gpt-6-astra']);
    expect(renderedRanks()).toEqual(['1', '2', '3']);
  });

  it('saves the order as array POSITION, carrying no rank field on the wire', async () => {
    render(<ExpertRoutingSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /move sol up/i }));
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));

    const args = h.mutate.mock.calls[0][0] as {
      allowlist: Array<Record<string, unknown>>;
      recencyHalfLifeDays: number;
    };
    expect(args.allowlist.map((e) => e.model)).toEqual(['fable', 'sol', 'opus', 'gpt-6-astra']);
    expect(args.allowlist.map((e) => e.agent)).toEqual(['claude', 'codex', 'claude', 'codex']);
    // Rank is positional — a rank field on the wire would be a second, conflicting
    // representation of the same policy.
    for (const entry of args.allowlist) expect(entry).not.toHaveProperty('rank');
    expect(args.recencyHalfLifeDays).toBe(30);
  });

  it('blocks the save on an empty list and explains the seed fallback', () => {
    render(<ExpertRoutingSettingsPage />);
    for (const model of ['fable', 'opus', 'sol', 'gpt-6-astra']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`remove ${model}`, 'i') }));
    }
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText(/at least one is required/i)).toBeTruthy();
    expect(isDisabled(saveButton())).toBe(true);
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('blocks the save when the half-life is outside the bounds the server reported', () => {
    render(<ExpertRoutingSettingsPage />);
    const field = screen.getByLabelText(/recency half-life in days/i);
    fireEvent.change(field, { target: { value: '900' } });
    expect(isDisabled(saveButton())).toBe(true);
    // The numbers come from the payload's `bounds`, not from a copy in the page.
    expect(screen.getByText(/between 0\.5 and 365 days/i)).toBeTruthy();

    fireEvent.change(field, { target: { value: '14' } });
    expect(isDisabled(saveButton())).toBe(false);
  });

  it('sends an edited half-life alongside the unchanged allowlist', async () => {
    render(<ExpertRoutingSettingsPage />);
    fireEvent.change(screen.getByLabelText(/recency half-life in days/i), {
      target: { value: '7' },
    });
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));

    const args = h.mutate.mock.calls[0][0] as {
      allowlist: Array<{ model: string }>;
      recencyHalfLifeDays: number;
    };
    expect(args.recencyHalfLifeDays).toBe(7);
    // The whole list rides along, so the route's merge can never be the only
    // thing standing between a half-life edit and a reset allowlist.
    expect(args.allowlist.map((e) => e.model)).toEqual(['fable', 'opus', 'sol', 'gpt-6-astra']);
  });

  it('offers no already-ranked pair in the add picker (the store would dedupe it)', () => {
    h.row = mkRow({ allowlist: [{ rank: 1, agent: 'claude', model: 'opus' }] });
    render(<ExpertRoutingSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /add a model/i }));

    const picker = screen.getByLabelText(/model to allow/i);
    const opus = Array.from(picker.querySelectorAll('option')).find((o) => o.value === 'opus');
    const fable = Array.from(picker.querySelectorAll('option')).find((o) => o.value === 'fable');
    expect(isDisabled(opus)).toBe(true);
    expect(isDisabled(fable)).toBe(false);
  });

  it('adds a model from the picker with the backend the alias launches on', async () => {
    h.row = mkRow({ allowlist: [{ rank: 1, agent: 'claude', model: 'fable' }] });
    render(<ExpertRoutingSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /add a model/i }));
    fireEvent.change(screen.getByLabelText(/model to allow/i), { target: { value: 'sol' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(renderedModels()).toEqual(['fable', 'sol']);
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));
    const args = h.mutate.mock.calls[0][0] as { allowlist: Array<{ agent: string; model: string }> };
    // `sol` is a codex alias — the backend comes from the menu, not a guess.
    expect(args.allowlist[1]).toEqual({ agent: 'codex', model: 'sol' });
  });

  it('restores the defaults the server reported, without saving them itself', () => {
    h.row = mkRow({ allowlist: [{ rank: 1, agent: 'omp', model: 'something-else' }] });
    render(<ExpertRoutingSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /restore defaults/i }));
    expect(renderedModels()).toEqual(['fable', 'opus', 'sol', 'gpt-6-astra']);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
  });

  it('reverts drafts back to the stored value', () => {
    render(<ExpertRoutingSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: /remove fable/i }));
    expect(renderedModels()).toEqual(['opus', 'sol', 'gpt-6-astra']);
    fireEvent.click(screen.getByRole('button', { name: /revert/i }));
    expect(renderedModels()).toEqual(['fable', 'opus', 'sol', 'gpt-6-astra']);
    expect(isDisabled(saveButton())).toBe(true);
  });

  it('surfaces a read failure instead of rendering a silent blank', () => {
    h.row = undefined;
    h.error = new Error('pg down');
    render(<ExpertRoutingSettingsPage />);
    expect(screen.getByText(/could not read expert-routing settings/i)).toBeTruthy();
  });

  it('states that recency ranks candidates but never gates qualification', () => {
    render(<ExpertRoutingSettingsPage />);
    // The owner's constraint is load-bearing copy, not decoration
    // ([owner 2026-09-22] recency is comparison-only).
    expect(screen.getByText(/never decides whether someone qualifies/i)).toBeTruthy();
  });
});
