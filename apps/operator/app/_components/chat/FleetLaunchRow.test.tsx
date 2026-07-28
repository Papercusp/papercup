// @vitest-environment jsdom
/**
 * FleetLaunchRow (WI-6505) — the agent chat popup's always-visible fleet-launch
 * row.
 *
 * What these tests are actually defending:
 *  1. Every option the owner named is REACHABLE (account, model, headed/headless,
 *     how many, and the system-vs-gateway-pin choice that rides `account`). The
 *     ask was "all the options for fleet launching that agents are supposed to
 *     ask a user about" — a row missing one of them silently sends agents back
 *     to asking in chat, which is the thing this replaces.
 *  2. The launch reaches the REAL launcher with the REAL values. "A launcher
 *     that cannot actually launch is not done" — so the POST body is asserted
 *     field by field, not just that a fetch happened.
 *  3. A launch that opens ZERO members is reported as a FAILURE even though the
 *     HTTP call succeeded. `fleet:launch-on-plan` answers 200 with `ok:false`
 *     when capacity clamps the wave to nothing, so a naive `if (r.ok)` would
 *     toast "launched" for a fleet that does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

/**
 * The REAL nuqs, through its first-party testing adapter — deliberately not a
 * `vi.mock('nuqs')` stub.
 *
 * This component's selections ARE its URL state, so a stub whose setters write
 * to a plain object without re-rendering would let every "pick X, then launch"
 * assertion pass or fail for reasons unrelated to the component: the value the
 * launch reads would be whatever leaked in from a previous test rather than
 * what this test picked. The adapter is also what `nuqs-mock.ts` itself points
 * at first for suites that can render through a real adapter tree.
 */
function renderRow(ui: React.ReactElement) {
  return render(<NuqsTestingAdapter>{ui}</NuqsTestingAdapter>);
}

// The two option sources are network-backed; stub them to fixed lists so the
// assertions below are about THIS component, not about plan/account fetching.
const planRows = [
  { slug: 'hud-tab-public-release-2026-07-28', title: 'HUD tab public release', harness: 'papercusp', updated: null },
  { slug: 'other-plan', title: 'Other plan', harness: 'otherness', updated: null },
];
vi.mock('@/app/admin/plans/plans-api', () => ({
  usePlanList: () => ({ data: { plans: planRows }, loading: false, error: null }),
}));

const suLaunchRefresh = vi.fn();
vi.mock('@/app/adv/sessions/use-su-launch-options', () => ({
  useSuLaunchOptions: () => ({
    fleets: [],
    nextScheme: null,
    schemes: [],
    // A pool account — the "pin to an account using the inference gateway" row.
    accounts: [{ id: 'acct-pool-1', label: 'pool-one', detail: 'Pinned pool account' }],
    loading: false,
    error: null,
    refresh: suLaunchRefresh,
  }),
}));

// Same treatment NewSessionLauncher.test.tsx gives the pickers: stub the
// searchable Combobox to a native <select> (which also reports role="combobox")
// so these tests exercise LAUNCH logic — which values reach the launcher — not
// the combobox. Its own behaviour (open on focus, filter as you type, detail
// rows) is covered for real in app/harness/__tests__/Combobox.test.tsx.
vi.mock('@/app/harness/Combobox', () => ({
  Combobox: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (v: string) => void;
    ariaLabel?: string;
    disabled?: boolean;
    options: Array<
      | { value: string; label: string }
      | { kind: 'group'; label: string; options: { value: string; label: string }[] }
    >;
  }) => {
    const flat = options.flatMap((o) => ('kind' in o ? o.options : [o]));
    return (
      <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {flat.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  },
}));

const toastCalls: Array<{ kind: string; message: string }> = [];
vi.mock('sonner', () => ({
  toast: {
    success: (m: string) => toastCalls.push({ kind: 'success', message: m }),
    error: (m: string) => toastCalls.push({ kind: 'error', message: m }),
    warning: (m: string) => toastCalls.push({ kind: 'warning', message: m }),
  },
}));

import FleetLaunchRow, {
  FLEET_LAUNCH_ROUTE,
  HEADED_VALUE,
  HEADLESS_VALUE,
  WINDOW_MODE_OPTIONS,
  clampMemberCount,
  describeLaunchResult,
} from './FleetLaunchRow';
import { MODEL_SELECT_DEFAULT, OMP_MODEL_OPTIONS, modelBackend } from '@/app/adv/sessions/NewSessionLauncher';
import { FLEET_MAX_MEMBERS } from '@papercusp/operator-core/lib/agent-config-constants';

/**
 * A real claude-backed model id taken from the SHARED menu rather than a
 * hardcoded alias — the menu is derived from psu's own list and gains/loses
 * models over time (WI-6300), so a literal here would rot.
 */
const CLAUDE_MODEL =
  OMP_MODEL_OPTIONS.find((o) => o.value !== MODEL_SELECT_DEFAULT && modelBackend(o.value) === 'claude')!.value;

/** Build the agent-tools envelope the route really answers with. */
function envelope(payload: unknown, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError } : {}) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastCalls.length = 0;
  suLaunchRefresh.mockClear();
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => envelope({ ok: true, fleet: 'my-fleet', opened: [{}], failed: [] }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Fill the two structurally-required fields (name + lane) so a launch can proceed. */
function fillRequired(planSlug = planRows[0].slug) {
  fireEvent.change(screen.getByLabelText('Name for the new fleet'), { target: { value: 'my-fleet' } });
  fireEvent.change(screen.getByLabelText('Plan the fleet works'), { target: { value: planSlug } });
}

/** The single POST body the component sent. */
function sentBody(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body);
}

describe('clampMemberCount', () => {
  it('bounds to 1..FLEET_MAX_MEMBERS and never returns a fraction or NaN', () => {
    expect(clampMemberCount(0)).toBe(1);
    expect(clampMemberCount(-5)).toBe(1);
    expect(clampMemberCount(3)).toBe(3);
    expect(clampMemberCount(3.7)).toBe(3);
    expect(clampMemberCount(FLEET_MAX_MEMBERS + 40)).toBe(FLEET_MAX_MEMBERS);
    expect(clampMemberCount(Number.NaN)).toBe(1);
  });

  /**
   * The ceiling must come from the shared constant, not a literal copy. If
   * `fleet:launch-on-plan` raises its `.max()` and the UI keeps its own 12, the
   * row silently refuses counts the tool would accept — the drift class WI-6300
   * and WI-6321 were both filed for.
   */
  it('tracks the same ceiling the launcher enforces', () => {
    expect(clampMemberCount(1_000)).toBe(FLEET_MAX_MEMBERS);
  });
});

describe('describeLaunchResult', () => {
  it('reports a real launch as success with the member count', () => {
    const v = describeLaunchResult(envelope({ ok: true, fleet: 'alpha', opened: [{}, {}], failed: [] }));
    expect(v.ok).toBe(true);
    expect(v.message).toContain('2 members');
    expect(v.message).toContain('alpha');
  });

  /**
   * THE case a status-code check gets wrong. Capacity can clamp a wave to zero:
   * the HTTP call is a clean 200, `ok` is false, `opened` is empty. Reporting
   * that as success tells the human a fleet exists when none does.
   */
  it('a 200 that opened ZERO members is a failure, and surfaces the tool reason', () => {
    const v = describeLaunchResult(
      envelope({ ok: false, fleet: 'alpha', opened: [], failed: [], message: 'capacity clamped to 0' }),
    );
    expect(v.ok).toBe(false);
    expect(v.message).toBe('capacity clamped to 0');
  });

  it('counts partial failures without calling the launch a failure', () => {
    const v = describeLaunchResult(envelope({ ok: true, fleet: 'alpha', opened: [{}], failed: [{}, {}] }));
    expect(v.ok).toBe(true);
    expect(v.message).toContain('2 failed to open');
  });

  it('passes a non-JSON refusal through verbatim rather than inventing copy', () => {
    const v = describeLaunchResult({ content: [{ type: 'text', text: 'no such plan `nope`' }], isError: true });
    expect(v.ok).toBe(false);
    expect(v.message).toBe('no such plan `nope`');
  });

  it('does not throw on an empty/garbled envelope', () => {
    expect(describeLaunchResult(null).ok).toBe(false);
    expect(describeLaunchResult({}).ok).toBe(false);
  });
});

describe('FleetLaunchRow — the owner’s five options are all present', () => {
  it('renders unconditionally, with a control for every option', () => {
    renderRow(<FleetLaunchRow />);
    expect(screen.getByTestId('fleet-launch-row')).toBeTruthy();
    // (i) which account — and the same control carries the system-vs-gateway pin
    expect(screen.getByLabelText('Account routing for every fleet member')).toBeTruthy();
    // (ii) which model
    expect(screen.getByLabelText('Model for every fleet member')).toBeTruthy();
    // (iii) headed or headless
    expect(screen.getByLabelText('Headed or headless members')).toBeTruthy();
    // (iv) how many
    expect(screen.getByLabelText('How many members to launch')).toBeTruthy();
    // …plus the two the launcher structurally requires: a name and a lane.
    expect(screen.getByLabelText('Name for the new fleet')).toBeTruthy();
    expect(screen.getByLabelText('Plan the fleet works')).toBeTruthy();
  });

  /**
   * "default system account or pin to an account using the inference gateway"
   * is not a separate control — it is the three-mode grammar of psu's single
   * `--account` flag. All three modes must be offerable, or the owner's fifth
   * option is unreachable however good the row looks.
   */
  it('offers all three account modes: system default, gateway auto, and a pool pin', () => {
    renderRow(<FleetLaunchRow />);
    const account = screen.getByLabelText('Account routing for every fleet member') as HTMLSelectElement;
    const values = [...account.options].map((o) => o.value);
    expect(values).toContain('default');
    expect(values).toContain('auto');
    expect(values).toContain('acct-pool-1');
  });

  it('offers exactly headed and headless — the owner’s "headed or headed" typo resolved', () => {
    expect(WINDOW_MODE_OPTIONS.map((o) => o.value)).toEqual([HEADED_VALUE, HEADLESS_VALUE]);
  });

  it('bounds the count input to the launcher’s real range', () => {
    renderRow(<FleetLaunchRow />);
    const count = screen.getByLabelText('How many members to launch') as HTMLInputElement;
    expect(count.min).toBe('1');
    expect(count.max).toBe(String(FLEET_MAX_MEMBERS));
  });
});

describe('FleetLaunchRow — launching', () => {
  it('POSTs to the real fleet:launch-on-plan route with every chosen value', async () => {
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.change(screen.getByLabelText('How many members to launch'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Headed or headless members'), { target: { value: HEADLESS_VALUE } });
    fireEvent.change(screen.getByLabelText('Account routing for every fleet member'), {
      target: { value: 'acct-pool-1' },
    });

    fireEvent.click(screen.getByTestId('fleet-launch-submit'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(FLEET_LAUNCH_ROUTE);
    const body = sentBody();
    expect(body.name).toBe('my-fleet');
    expect(body.plan).toBe('hud-tab-public-release-2026-07-28');
    expect(body.count).toBe(3);
    expect(body.headless).toBe(true);
    expect(body.account).toBe('acct-pool-1');
  });

  /**
   * The tool resolves the plan against a harness, and an HTTP call carries no
   * agent session to inherit a harness scope from. Sending the PLAN'S OWN
   * harness is what makes a launch from this row resolvable at all — and it must
   * follow the picked plan, not a fixed default.
   */
  it('sends the harness of the SELECTED plan, not an ambient one', async () => {
    renderRow(<FleetLaunchRow />);
    fillRequired('other-plan');
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody().harness).toBe('otherness');
  });

  it('clamps an over-max count before it reaches the launcher', async () => {
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.change(screen.getByLabelText('How many members to launch'), { target: { value: '99' } });
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody().count).toBe(FLEET_MAX_MEMBERS);
  });

  it('defaults to one headed member on the system account', async () => {
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sentBody();
    expect(body.count).toBe(1);
    expect(body.headless).toBe(false);
    expect(body.account).toBe('default');
    // No model picked ⇒ neither model nor agent is sent, so the launcher keeps
    // its own default rather than being pinned to a guess.
    expect(body.model).toBeUndefined();
    expect(body.agent).toBeUndefined();
  });

  /**
   * A model pick IS implicitly a backend pick (the menu spans claude/codex/omp).
   * Sending the model without its backend launches the wrong CLI nominally set
   * to an unrunnable id — the trap that spawned 4 mislabelled members on
   * 2026-07-03. Both must travel together.
   */
  it('sends the model together with the backend that model belongs to', async () => {
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.change(screen.getByLabelText('Model for every fleet member'), { target: { value: CLAUDE_MODEL } });
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = sentBody();
    expect(body.model).toBe(CLAUDE_MODEL);
    expect(body.agent).toBe('claude');
  });

  it('refuses a nameless fleet without calling the launcher', async () => {
    renderRow(<FleetLaunchRow />);
    fireEvent.change(screen.getByLabelText('Plan the fleet works'), { target: { value: planRows[0].slug } });
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastCalls[0].kind).toBe('error');
  });

  it('refuses a fleet with no lane without calling the launcher', async () => {
    renderRow(<FleetLaunchRow />);
    fireEvent.change(screen.getByLabelText('Name for the new fleet'), { target: { value: 'my-fleet' } });
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastCalls[0].message).toContain('plan');
  });

  it('reports a zero-member launch as an error, not a success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => envelope({ ok: false, fleet: 'my-fleet', opened: [], failed: [], message: 'capacity clamped to 0' }),
    });
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].kind).toBe('error');
    expect(toastCalls[0].message).toBe('capacity clamped to 0');
  });

  it('reports a transport failure instead of silently doing nothing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].kind).toBe('error');
    expect(toastCalls[0].message).toContain('offline');
  });

  it('notifies the caller and refreshes the fleet list after a successful launch', async () => {
    const onLaunched = vi.fn();
    renderRow(<FleetLaunchRow onLaunched={onLaunched} />);
    fillRequired();
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith('my-fleet'));
    expect(suLaunchRefresh).toHaveBeenCalled();
    expect(toastCalls[0].kind).toBe('success');
  });
});
