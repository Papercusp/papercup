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

/* Select: a native <select>, the same stand-in the sibling suites use
   (PlansListPanel, AdvChatPanel). Radix renders its items into a portal that
   exists only while the menu is OPEN, so the option set is unassertable from
   the closed control — and the option set is exactly what D-011 is about.
   Deliberately renders ONLY the options it is handed: the component supplies
   its own "system default" entry, so a placeholder option added here would
   double it and hide a component that had stopped offering one. */
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    id,
    value,
    onChange,
    options,
    disabled,
  }: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    disabled?: boolean;
  }) => (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

import { toast } from 'sonner';
import { GOAL_LAUNCH_ROLES } from '@papercusp/operator-core/lib/goal-launch-settings';
import GoalSettingsSection from './GoalSettingsSection';
import type { GoalDetailLaunchSettings } from './goal-detail-model';

const fetchMock = vi.fn();

const OPTIONS = { agent: ['claude', 'codex', 'omp'], carry: ['warm', 'cold'], contextSize: ['trimmed'] };

function reply(body: Record<string, unknown>, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(reply({}));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(cleanup);

/** What the server ships for an unpinned ceiling (D-015). */
const DEFAULTS = { maxAgents: 12, maxPerFleet: 5 };

function mount(settings: GoalDetailLaunchSettings | null, invalid?: string | null) {
  return render(
    <GoalSettingsSection
      goalId="G-1"
      settings={settings}
      settingsInvalid={invalid}
      options={OPTIONS}
      defaults={DEFAULTS}
    />,
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
  it('reports the DEFAULT an unpinned goal runs under, not "no ceiling"', () => {
    // The summary is the only line most visits read, so this is where the
    // pre-D-015 reading ("nothing set" ⇒ "nothing in force") would survive
    // longest after the resolver stopped agreeing with it.
    mount(null);
    const text = screen.getByTestId('goal-settings-summary').textContent ?? '';
    expect(text).toContain('Max 12 agents');
    expect(text).toContain('default');
  });

  it('reserves "No agent ceiling" for a goal that opted out ON PURPOSE', () => {
    mount({ maxAgents: 'unlimited' });
    expect(screen.getByTestId('goal-settings-summary').textContent).toContain('No agent ceiling');
  });

  it('reads DIFFERENTLY for defaulted vs deliberately unbounded — they are not the same goal', () => {
    const { unmount } = mount(null);
    const defaulted = screen.getByTestId('goal-settings-summary').textContent;
    unmount();
    mount({ maxAgents: 'unlimited', maxPerFleet: 'unlimited' });
    expect(screen.getByTestId('goal-settings-summary').textContent).not.toBe(defaulted);
  });

  it('leads with the ceiling in force', () => {
    mount({ maxAgents: 3 });
    expect(screen.getByTestId('goal-settings-summary').textContent).toContain('Max 3 agents');
  });
});

describe('GoalSettingsSection — the unlimited opt-out', () => {
  const noCeiling = () => screen.getAllByRole('checkbox', { name: /no ceiling/i })[0];

  it('writes the explicit literal, not a blank field', () => {
    mount(null);
    open();
    fireEvent.click(noCeiling());
    fireEvent.click(saveBtn());
    expect(writtenBody().launchSettings).toEqual({ maxAgents: 'unlimited' });
  });

  it('clearing the opt-out returns the ceiling to the DEFAULT, not to a number', () => {
    mount({ maxAgents: 'unlimited' });
    open();
    fireEvent.click(noCeiling());
    fireEvent.click(saveBtn());
    // Nothing pinned at all ⇒ the whole document clears, and the resolver's
    // default takes over. Landing on some remembered number instead would pin a
    // ceiling the owner never chose.
    expect(writtenBody().launchSettings).toBeNull();
  });

  it('a typed number and the opt-out cannot both be in force', () => {
    mount({ maxAgents: 4 });
    open();
    expect(maxAgents().value).toBe('4');
    fireEvent.click(noCeiling());
    expect(maxAgents().disabled).toBe(true);
    fireEvent.click(saveBtn());
    expect(writtenBody().launchSettings).toEqual({ maxAgents: 'unlimited' });
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
  it('authors intended plan-fleet width independently of the ceilings', async () => {
    mount({ maxAgents: 12, maxPerFleet: 5 });
    open();
    fireEvent.change(screen.getByLabelText('Concurrent plan fleets intended'), { target: { value: '2' } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(writtenBody().launchSettings).toEqual({ maxAgents: 12, maxPerFleet: 5, intendedParallelPlanFleets: 2 });
  });
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
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'plan-fleet-member' } });
    // Two "Effort" fields exist once a role row is open (defaults + the role),
    // so target the role's by its scoped id rather than by label text.
    const roleEffort = document.querySelector<HTMLInputElement>('input[id$="-effort"][id*="role-"]')!;
    fireEvent.change(roleEffort, { target: { value: 'high' } });
    fireEvent.click(saveBtn());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(writtenBody().launchSettings).toEqual({
      roles: { 'plan-fleet-member': { effort: 'high' } },
    });
  });

  it('refuses a role that pins nothing instead of dropping the row silently', async () => {
    mount(null);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Add role profile' }));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'plan-fleet-member' } });
    fireEvent.click(saveBtn());

    expect((await screen.findByTestId('goal-settings-problems')).textContent).toContain('pins no settings');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // D-016 (WI-38048): the role key is a closed launch-slot vocabulary. The panel
  // is the owner's ONLY authoring surface for it, so "the server binds by slot"
  // is only half a fix — these pin the half that makes a slot reachable.
  it('offers the launch slots as a picker rather than a free-text box', () => {
    mount(null);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Add role profile' }));

    const role = screen.getByLabelText('Role');
    // A text input would accept a psu persona and store a key that binds
    // nothing — the exact defect D-016 closes.
    expect(role.tagName).toBe('SELECT');
    const values = Array.from((role as HTMLSelectElement).options).map((o) => o.value);
    for (const slot of GOAL_LAUNCH_ROLES) expect(values).toContain(slot);
    expect(values).not.toContain('engineer');
  });

  it('shows a legacy free-text key and refuses to save it, rather than hiding the row', () => {
    // A document written before the vocabulary closed. Dropping the row would
    // leave the owner unable to see (or fix) the setting that is not binding.
    mount({ roles: { engineer: { effort: 'high' } } } as never);
    open();

    const role = screen.getByLabelText('Role') as HTMLSelectElement;
    expect(role.value).toBe('engineer');
    fireEvent.click(saveBtn());
    expect(screen.getByTestId('goal-settings-problems').textContent).toContain(
      'is not a launch slot',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GoalSettingsSection — the option lists come from the server (D-011)', () => {
  const agent = () => screen.getByLabelText('Agent') as HTMLSelectElement;

  it('offers exactly the agents the payload carried, plus an explicit unset', () => {
    mount(null);
    open();
    // The sentinel stands in for '': Radix throws on an Item valued '', and the
    // wrapper drops such options defensively, so an unset choice travelling as
    // the empty string would vanish silently.
    expect([...agent().options].map((o) => o.value)).toEqual([
      '__system_default__',
      'claude',
      'codex',
      'omp',
    ]);
  });

  it('maps the unset choice back to an ABSENT key, not to a pinned sentinel', async () => {
    // The round-trip that matters: the sentinel must never reach the store, or
    // the goal would launch pinned to a model literally called
    // "__system_default__".
    mount({ defaults: { agent: 'codex' } });
    open();
    fireEvent.change(agent(), { target: { value: '__system_default__' } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(writtenBody().launchSettings).toBeNull();
  });

  it('pins the agent the owner picked', async () => {
    mount(null);
    open();
    fireEvent.change(agent(), { target: { value: 'codex' } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(writtenBody().launchSettings).toEqual({ defaults: { agent: 'codex' } });
  });

  it('falls back to a text input when the payload carried no options', () => {
    // Degraded but still editable, and it still cannot offer a wrong value —
    // the server validates either way. An empty select would just be dead.
    render(<GoalSettingsSection goalId="G-1" settings={null} options={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Agent') as HTMLElement).tagName).toBe('INPUT');
  });
});
