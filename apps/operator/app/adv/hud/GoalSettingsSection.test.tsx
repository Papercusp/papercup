// @vitest-environment jsdom
/**
 * GoalSettingsSection behaviour (goal-mode-hardening-2026-08-10 P-005).
 *
 * The form's pure conversion rules are covered next door in
 * goal-launch-settings-model.test.ts. What is left here is everything only the
 * mounted component can be wrong about, and every one of them is a way the
 * ceiling reads as saved when it is not:
 *
 *   1. A `degraded: true` reply on HTTP 200 must not read as success. The admin
 *      route returns `goals:update`'s result verbatim precisely so a caller
 *      cannot render a write that did not land as a write that did
 *      (EI-19995648221353323). A component that only checks `res.ok` re-creates
 *      that bug — with a ceiling, which is what stops a goal agent from
 *      launching an unbounded fleet.
 *   2. An UNREADABLE stored document must be shown as an alarm, not as "no
 *      settings". Those two states look identical on the page and mean opposite
 *      things about whether the owner's limit is holding.
 *   3. A background re-pull must not delete what the owner is typing — and the
 *      control for that negative is that it DOES re-sync when they are not
 *      typing. Asserting only the first half passes against a component that
 *      never syncs at all.
 *
 * Negatives are paired throughout, for the reason the sibling suite records: an
 * absence assertion in jsdom passes for reasons unrelated to the design unless
 * something proves the thing CAN happen.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/* The same local nuqs stand-in the sibling suites use: a real adapter would drag
   the router in for a param whose only job here is to flip a boolean. */
vi.mock('nuqs', async () => {
  const React = await import('react');
  const parser = <T,>() => ({
    withDefault(defaultValue: T) {
      return { defaultValue };
    },
  });
  return {
    parseAsBoolean: parser<boolean>(),
    parseAsString: parser<string>(),
    useQueryState(_key: string, p?: { defaultValue?: unknown }) {
      const [value, setValue] = React.useState<unknown>(p?.defaultValue ?? null);
      const set = React.useCallback((next: unknown) => {
        setValue(typeof next === 'function' ? (next as (prev: unknown) => unknown)(value) : next);
        return Promise.resolve(new URLSearchParams());
      }, [value]);
      return [value, set];
    },
  };
});

import { toast } from 'sonner';
import GoalSettingsSection from './GoalSettingsSection';
import type { GoalDetailLaunchSettings } from './goal-detail-model';

const fetchMock = vi.fn();

const OPTIONS = { agent: ['claude', 'codex', 'omp'], carry: ['warm', 'cold'], contextSize: ['full', 'trimmed'] };

function reply(body: Record<string, unknown>, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(reply({}));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(cleanup);

function mount(settings: GoalDetailLaunchSettings | null, invalid?: string | null) {
  return render(
    <GoalSettingsSection goalId="G-1" settings={settings} settingsInvalid={invalid} options={OPTIONS} />,
  );
}

/** The JSON body of the Nth (default: only) write, as the route received it. */
function writtenBody(n = 0): { id?: string; launchSettings?: unknown } {
  const call = fetchMock.mock.calls[n];
  return JSON.parse((call?.[1] as { body: string }).body) as { id?: string; launchSettings?: unknown };
}

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
const maxAgents = () => screen.getByLabelText('Max agents') as HTMLInputElement;
const saveBtn = () => screen.getByRole('button', { name: /Save settings/ }) as HTMLButtonElement;

describe('GoalSettingsSection — collapsed summary', () => {
  it('says an absent ceiling is absent rather than showing nothing', () => {
    mount(null);
    expect(screen.getByTestId('goal-settings-summary').textContent).toBe('No agent ceiling');
  });

  it('leads with the ceiling in force', () => {
    mount({ maxAgents: 3 });
    expect(screen.getByTestId('goal-settings-summary').textContent).toContain('Max 3 agents');
  });
});

describe('GoalSettingsSection — an unreadable document is an alarm, not an absence', () => {
  it('says the ceiling is NOT in force', () => {
    mount(null, 'goal G-1 launch settings is invalid: maxAgents');
    expect(screen.getByTestId('goal-settings-invalid').textContent).toContain('no ceiling is in force');
  });

  it('shows no alarm when the document is merely absent — the control for the above', () => {
    mount(null);
    expect(screen.queryByTestId('goal-settings-invalid')).toBeNull();
  });
});

describe('GoalSettingsSection — writing', () => {
  it('posts the edited document to goals:update', async () => {
    mount({ maxAgents: 3 });
    open();
    fireEvent.change(maxAgents(), { target: { value: '5' } });
    fireEvent.click(saveBtn());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/admin/goals/update');
    expect(writtenBody()).toEqual({ id: 'G-1', launchSettings: { maxAgents: 5 } });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('sends null — not {} — when the last setting is cleared', async () => {
    // "No settings" must be ONE state in the database; `{}` would be a second
    // spelling of it that reads back identically and compares differently.
    mount({ maxAgents: 3 });
    open();
    fireEvent.change(maxAgents(), { target: { value: '' } });
    fireEvent.click(saveBtn());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(writtenBody().launchSettings).toBeNull();
  });

  it('does NOT read a degraded 200 as success', async () => {
    // The failure this suite exists for: HTTP 200 with the write reporting
    // itself degraded means the ceiling was not stored.
    fetchMock.mockResolvedValue(
      reply({ degraded: true, degradedReasons: ['launch settings NOT saved: connection lost'] }),
    );
    mount({ maxAgents: 3 });
    open();
    fireEvent.change(maxAgents(), { target: { value: '5' } });
    fireEvent.click(saveBtn());

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error).mock.calls[0]![1]).toMatchObject({
      description: expect.stringContaining('connection lost'),
    });
  });

  it('reports a refused write', async () => {
    fetchMock.mockResolvedValue(reply({ error: { message: 'nope' } }, { ok: false, status: 403 }));
    mount({ maxAgents: 3 });
    open();
    fireEvent.change(maxAgents(), { target: { value: '5' } });
    fireEvent.click(saveBtn());

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('refuses locally — without a write — when the input cannot be valid', async () => {
    mount(null);
    open();
    fireEvent.change(maxAgents(), { target: { value: '0' } });
    fireEvent.click(saveBtn());

    expect(await screen.findByTestId('goal-settings-problems')).toBeTruthy();
    // The point of refusing locally: nothing was sent to be refused remotely.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cannot be saved when nothing changed', () => {
    mount({ maxAgents: 3 });
    open();
    expect(saveBtn().disabled).toBe(true);
    // The control: it enables on a real change, so the assertion above is about
    // dirtiness rather than about a button that is always dead.
    fireEvent.change(maxAgents(), { target: { value: '4' } });
    expect(saveBtn().disabled).toBe(false);
  });
});

describe('GoalSettingsSection — re-sync from the server', () => {
  it('picks up a document changed elsewhere', () => {
    const { rerender } = mount({ maxAgents: 3 });
    open();
    expect(maxAgents().value).toBe('3');

    rerender(
      <GoalSettingsSection goalId="G-1" settings={{ maxAgents: 9 }} options={OPTIONS} />,
    );
    expect(maxAgents().value).toBe('9');
  });

  it('does NOT overwrite an edit in progress', () => {
    // The opposite failure, and the worse one: a `goals.detail` invalidation
    // this popup did not cause would otherwise delete what the owner typed.
    const { rerender } = mount({ maxAgents: 3 });
    open();
    fireEvent.change(maxAgents(), { target: { value: '7' } });

    rerender(
      <GoalSettingsSection goalId="G-1" settings={{ maxAgents: 9 }} options={OPTIONS} />,
    );
    expect(maxAgents().value).toBe('7');
  });
});

describe('GoalSettingsSection — role profiles', () => {
  it('adds, fills and saves a per-role profile', async () => {
    mount(null);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Add role profile' }));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'engineer' } });
    // Two "Effort" fields exist once a role row is open (defaults + the role),
    // so target the role's by its scoped id rather than by label text.
    const roleEffort = document.querySelector<HTMLInputElement>('input[id$="-effort"][id*="role-"]')!;
    fireEvent.change(roleEffort, { target: { value: 'high' } });
    fireEvent.click(saveBtn());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(writtenBody().launchSettings).toEqual({ roles: { engineer: { effort: 'high' } } });
  });

  it('refuses a role that pins nothing instead of dropping the row silently', async () => {
    mount(null);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Add role profile' }));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'engineer' } });
    fireEvent.click(saveBtn());

    expect((await screen.findByTestId('goal-settings-problems')).textContent).toContain('pins no settings');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GoalSettingsSection — the option lists come from the server (D-011)', () => {
  it('offers exactly the agents the payload carried', () => {
    mount(null);
    open();
    const sel = screen.getByLabelText('Agent') as HTMLSelectElement;
    // '' is the "system default" choice — absent, not a pinned value.
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'claude', 'codex', 'omp']);
  });

  it('falls back to a text input when the payload carried no options', () => {
    // Degraded but still editable, and it still cannot offer a wrong value —
    // the server validates either way. An empty select would just be dead.
    render(<GoalSettingsSection goalId="G-1" settings={null} options={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Agent') as HTMLElement).tagName).toBe('INPUT');
  });
});
