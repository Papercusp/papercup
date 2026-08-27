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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// The launch seam. Mocked at `launchAgent` (not at `fetch`) because that is the
// contract this row depends on — the GUI's one audited spawn path — and its own
// HTTP behaviour is launch-agent.ts's to test, not this component's.
const launchCalls: Array<Record<string, any>> = [];
let launchImpl: (o: Record<string, any>) => Promise<Record<string, any>>;
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({
  launchAgent: (o: Record<string, any>) => {
    launchCalls.push(o);
    return launchImpl(o);
  },
}));

import FleetLaunchRow, {
  HEADED_VALUE,
  HEADLESS_VALUE,
  WINDOW_MODE_OPTIONS,
  clampMemberCount,
  describeLaunchOutcome,
} from './FleetLaunchRow';
import { MODEL_SELECT_DEFAULT, OMP_MODEL_OPTIONS, modelBackend } from '@/app/adv/sessions/NewSessionLauncher';

/**
 * A real claude-backed model id taken from the SHARED menu rather than a
 * hardcoded alias — the menu is derived from psu's own list and gains/loses
 * models over time (WI-6300), so a literal here would rot.
 */
const CLAUDE_MODEL =
  OMP_MODEL_OPTIONS.find((o) => o.value !== MODEL_SELECT_DEFAULT && modelBackend(o.value) === 'claude')!.value;

beforeEach(() => {
  toastCalls.length = 0;
  launchCalls.length = 0;
  suLaunchRefresh.mockClear();
  // Default: every member launches cleanly, and the server reports the slug it
  // assigned the new fleet.
  launchImpl = async () => ({ ok: true, fleetSlug: 'my-fleet' });
});

afterEach(() => {
  cleanup();
});

/** Fill the two structurally-required fields (name + lane) so a launch can proceed. */
function fillRequired(planSlug = planRows[0].slug) {
  fireEvent.change(screen.getByLabelText('Fleet name'), { target: { value: 'my-fleet' } });
  fireEvent.change(screen.getByLabelText('Plan the fleet works'), { target: { value: planSlug } });
}

/** The options the FIRST member was launched with. */
function firstLaunch(): Record<string, any> {
  expect(launchCalls.length).toBeGreaterThan(0);
  return launchCalls[0];
}

describe('clampMemberCount', () => {
  it('bounds to positive integers and never returns a fraction or NaN', () => {
    expect(clampMemberCount(0)).toBe(1);
    expect(clampMemberCount(-5)).toBe(1);
    expect(clampMemberCount(3)).toBe(3);
    expect(clampMemberCount(3.7)).toBe(3);
    expect(clampMemberCount(1_000)).toBe(1_000);
    expect(clampMemberCount(Number.NaN)).toBe(1);
  });

});

describe('describeLaunchOutcome', () => {
  it('reports a full launch as success with the member count', () => {
    const v = describeLaunchOutcome([{ ok: true }, { ok: true }], 'alpha');
    expect(v.ok).toBe(true);
    expect(v.message).toContain('2 members');
    expect(v.message).toContain('alpha');
  });

  it('singularises a one-member fleet', () => {
    expect(describeLaunchOutcome([{ ok: true }], 'alpha').message).toContain('1 member on');
  });

  /**
   * A PARTIAL launch is the case a naive "did the last call succeed" check gets
   * wrong in both directions — it is neither a clean success nor a failure, and
   * the human needs the shortfall stated or they will believe they have 3
   * members working when they have 1.
   */
  it('a partial launch is a success that STATES the shortfall', () => {
    const v = describeLaunchOutcome([{ ok: true }, { ok: false, error: 'no terminal' }, { ok: false }], 'alpha');
    expect(v.ok).toBe(true);
    expect(v.message).toContain('1 member');
    expect(v.message).toContain('2 failed to start');
  });

  /** Every member failed ⇒ a failure that surfaces the server's real reason. */
  it('an all-failed launch is a failure carrying the first real error', () => {
    const v = describeLaunchOutcome([{ ok: false, error: '`psu` not found on PATH' }, { ok: false }], 'alpha');
    expect(v.ok).toBe(false);
    expect(v.message).toBe('`psu` not found on PATH');
  });

  it('still fails legibly when no member reported a reason', () => {
    const v = describeLaunchOutcome([{ ok: false }], 'alpha');
    expect(v.ok).toBe(false);
    expect(v.message).toContain('alpha');
  });

  /** EI-18696184925888288: launch-su can report ok with a "window may not have
   *  opened" warning. That must not read as an unqualified success. */
  it('surfaces a may-not-have-opened warning on an otherwise clean launch', () => {
    const v = describeLaunchOutcome([{ ok: true, warning: 'exited immediately' }], 'alpha');
    expect(v.ok).toBe(true);
    expect(v.message).toContain('may not have opened');
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
    expect(screen.getByLabelText('Members')).toBeTruthy();
    // …plus the two the launcher structurally requires: a name and a lane.
    expect(screen.getByLabelText('Fleet name')).toBeTruthy();
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

  it('enforces only the positive count floor', () => {
    renderRow(<FleetLaunchRow />);
    const count = screen.getByLabelText('Members') as HTMLInputElement;
    expect(count.min).toBe('1');
    expect(count.max).toBe('');
  });
});

describe('FleetLaunchRow — launching', () => {
  it('launches one member PER count, with every chosen value on each', async () => {
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.change(screen.getByLabelText('Members'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Headed or headless members'), { target: { value: HEADLESS_VALUE } });
    fireEvent.change(screen.getByLabelText('Account routing for every fleet member'), {
      target: { value: 'acct-pool-1' },
    });

    fireEvent.click(screen.getByTestId('fleet-launch-submit'));

    await waitFor(() => expect(launchCalls.length).toBe(3));
    for (const call of launchCalls) {
      expect(call.planSlug).toBe('hud-tab-public-release-2026-07-28');
      expect(call.headless).toBe(true);
      expect(call.account).toBe('acct-pool-1');
    }
  });

  /**
   * The FIRST member creates the fleet; the REST must JOIN the slug the server
   * assigned. If they each carried `fleetName` instead, a "3-member fleet" would
   * be three separate one-member fleets — the failure this ordering prevents.
   */
  it('member 1 CREATES the fleet; members 2..N join the slug the server returned', async () => {
    launchImpl = async () => ({ ok: true, fleetSlug: 'server-assigned-slug' });
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.change(screen.getByLabelText('Members'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));

    await waitFor(() => expect(launchCalls.length).toBe(3));
    expect(launchCalls[0].fleetName).toBe('my-fleet');
    expect(launchCalls[0].fleet).toBeNull();
    for (const call of launchCalls.slice(1)) {
      expect(call.fleet).toBe('server-assigned-slug');
      expect(call.fleetName).toBeNull();
    }
  });

  /** A failed first member means there is no fleet to join — do not fan out N-1
   *  more launches whose failures would only bury the real error. */
  it('does NOT fan out the remaining members when the first one fails', async () => {
    launchImpl = async () => ({ ok: false, error: '`psu` not found on PATH' });
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.change(screen.getByLabelText('Members'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));

    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(launchCalls.length).toBe(1);
    expect(toastCalls[0].kind).toBe('error');
    expect(toastCalls[0].message).toBe('`psu` not found on PATH');
  });

  /**
   * launch-su resolves the plan against a harness and has no agent session to
   * inherit a scope from, so the PLAN'S OWN harness must travel with it — and it
   * must follow the picked plan, not a fixed default.
   */
  it('sends the harness of the SELECTED plan, not an ambient one', async () => {
    renderRow(<FleetLaunchRow />);
    fillRequired('other-plan');
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(launchCalls.length).toBe(1));
    expect(firstLaunch().slug).toBe('otherness');
  });

  it('passes large governed counts through to the launcher', async () => {
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.change(screen.getByLabelText('Members'), { target: { value: '99' } });
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(launchCalls.length).toBe(99));
  });

  it('defaults to one headed member on the system account', async () => {
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(launchCalls.length).toBe(1));
    const call = firstLaunch();
    expect(call.headless).toBe(false);
    expect(call.account).toBe('default');
    // No model picked ⇒ neither model nor agent is sent, so the launcher keeps
    // its own default rather than being pinned to a guess.
    expect(call.model).toBeNull();
    expect(call.agent).toBeUndefined();
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
    await waitFor(() => expect(launchCalls.length).toBe(1));
    const call = firstLaunch();
    expect(call.model).toBe(CLAUDE_MODEL);
    expect(call.agent).toBe('claude');
  });

  it('refuses a nameless fleet without calling the launcher', async () => {
    renderRow(<FleetLaunchRow />);
    fireEvent.change(screen.getByLabelText('Plan the fleet works'), { target: { value: planRows[0].slug } });
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(launchCalls.length).toBe(0);
    expect(toastCalls[0].kind).toBe('error');
  });

  it('refuses a fleet with no lane without calling the launcher', async () => {
    renderRow(<FleetLaunchRow />);
    fireEvent.change(screen.getByLabelText('Fleet name'), { target: { value: 'my-fleet' } });
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(launchCalls.length).toBe(0);
    expect(toastCalls[0].message).toContain('plan');
  });

  /** A partial launch must not read as a clean success in the UI either. */
  it('reports a partial launch honestly', async () => {
    let n = 0;
    launchImpl = async () => {
      n += 1;
      return n === 1 ? { ok: true, fleetSlug: 'my-fleet' } : { ok: false, error: 'no terminal' };
    };
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.change(screen.getByLabelText('Members'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].kind).toBe('success');
    expect(toastCalls[0].message).toContain('2 failed to start');
  });

  it('reports a thrown transport failure instead of silently doing nothing', async () => {
    launchImpl = async () => {
      throw new Error('offline');
    };
    renderRow(<FleetLaunchRow />);
    fillRequired();
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    expect(toastCalls[0].kind).toBe('error');
    expect(toastCalls[0].message).toContain('offline');
  });

  it('notifies the caller with the SERVER’s slug and refreshes the fleet list', async () => {
    const onLaunched = vi.fn();
    renderRow(<FleetLaunchRow onLaunched={onLaunched} />);
    fillRequired();
    fireEvent.click(screen.getByTestId('fleet-launch-submit'));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith('my-fleet'));
    expect(suLaunchRefresh).toHaveBeenCalled();
    expect(toastCalls[0].kind).toBe('success');
  });
});

/* ── WI-7110: ONE stylesheet owns this component's layout ────────────────────
   [owner 2026-08-02] "The display of the bottom panel is all messed up."

   The cause was not a wrong value — it was a SPLIT owner. P-007 restructured
   this component into three stacked bands and styled the inner two in
   chat-controls.css, while hud.css kept a pre-P-007 `flex-direction: row` on the
   CONTAINER. The three bands then laid out side by side: the caption became a
   left-hand column, the field grid shrank until `auto-fit` collapsed to a single
   148px column, and the submit band's own `border-top` floated mid-panel as a
   stray rule above an orphaned button.

   Nothing caught it because the two rules lived in different files, so no reader
   and no test ever saw them together — and a jsdom render cannot catch it either
   (no stylesheet is applied, which is exactly why every behavioural test above
   stayed green through the whole regression). The guard therefore has to be a
   SOURCE assertion: it is the only kind that can observe the disagreement.

   This locks the invariant, not the value: change the layout freely, but change
   it in one place. ── */
describe('WI-7110: the fleet row’s container layout has exactly one owner', () => {
  const chatControlsCss = readFileSync(join(__dirname, 'chat-controls.css'), 'utf8');
  const hudCss = readFileSync(join(__dirname, '../../adv/hud/hud.css'), 'utf8');

  /** Rule bodies for a selector whose LAST simple selector is `.pc-fleet-launch-row`
   *  — i.e. rules that style the CONTAINER itself, not a descendant of it. */
  /**
   * The DECLARATION BODY of the rule whose selector list contains `selector`
   * exactly (WI-7456).
   *
   * Deliberately not the `css.split('}').find(b => b.includes(sel))` idiom used
   * elsewhere in this file: that returns everything since the previous `}`,
   * which is the preceding COMMENT plus the rule — so a selector name mentioned
   * in prose matches, and an assertion can pass against documentation rather
   * than against a declaration. These bands now carry long comments naming
   * their own selectors, which makes that failure mode likely rather than
   * theoretical.
   */
  function ruleBody(css: string, selector: string): string {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const match = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, sel]) =>
      sel.split(',').some((s) => s.trim() === selector),
    );
    expect(match, `no rule for "${selector}"`).toBeTruthy();
    return match![2];
  }

  function containerRuleBodies(css: string): string[] {
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) =>
        selector
          .split(',')
          .some((s) => s.trim().replace(/::?[a-z-]+(\([^)]*\))?$/i, '').trim().endsWith('.pc-fleet-launch-row')),
      )
      .map(([, , body]) => body);
  }

  it('chat-controls.css sets the container to a COLUMN — the grid needs the full width to spread', () => {
    const bodies = containerRuleBodies(chatControlsCss).join('\n');
    expect(bodies).toMatch(/flex-direction:\s*column/);
  });

  it('hud.css does not style the container at all — it is not this component’s stylesheet', () => {
    // A `.pc-fleet-launch-row {...}` block reappearing here is the exact shape
    // of the original bug, whatever it declares.
    expect(containerRuleBodies(hudCss)).toEqual([]);
  });

  it('no stylesheet lays the container out as a ROW', () => {
    for (const css of [chatControlsCss, hudCss]) {
      expect(containerRuleBodies(css).join('\n')).not.toMatch(/flex-direction:\s*row/);
    }
  });

  /* ── [owner 2026-08-02] "make it more compact you should be able to fit all
        the things on 1 or 2 lines."

     The row rendered FIVE lines for seven controls: a caption band, a
     six-cell grid whose cells each stacked a caption above its control, and a
     submit band. Each of the three tests below pins one of the three changes
     that removed a line, because any one of them silently regressing puts the
     line back and nothing else would notice. ── */
  describe('compaction — the launcher is one strip, not stacked bands', () => {
    it('renders NO band elements — the caption and the submit joined the strip', () => {
      const { container } = renderRow(<FleetLaunchRow />);
      // .pc-ctl-band is the band shape. The launcher used to contain two of
      // them (caption, submit); a compact strip contains none.
      expect(container.querySelectorAll('.pc-ctl-band').length).toBe(0);
    });

    it('puts the submit INSIDE the field strip, so it shares a line instead of owning one', () => {
      const { container } = renderRow(<FleetLaunchRow />);
      const strip = container.querySelector('.pc-fleet-launch-row__fields');
      const submit = screen.getByTestId('fleet-launch-submit');
      expect(strip).toBeTruthy();
      expect(strip!.contains(submit)).toBe(true);
    });

    it('lays every field caption BESIDE its control, not above it', () => {
      const { container } = renderRow(<FleetLaunchRow />);
      const fields = container.querySelectorAll('.pc-ctl-field');
      expect(fields.length).toBeGreaterThan(0);
      // Every field carries the inline modifier. A field that loses it goes
      // back to the stacked shape and re-adds a line to the strip.
      for (const f of fields) {
        expect(f.classList.contains('pc-ctl-field--inline')).toBe(true);
      }
    });

    /* ⚠ REPLACED 2026-08-03 (WI-7456). This asserted `flex-wrap: wrap`, which
       was the MECHANISM, not the promise — and that mechanism is precisely what
       produced the owner's third alignment complaint: a wrapped flex line
       restarts at the container's padding, so line 2 began underneath the FLEET
       cap, 49px out of column with line 1 (measured: captions 49.1px apart,
       wells 18.4/27.2/42.1px apart). Flexbox cannot express "wrap, but not into
       the first item's column", so the strip is a grid now.

       The PROMISE this case defends is unchanged — reflow, never a clipped
       control — and the grid keeps it with `auto-fit` + `minmax`. It also
       guarantees the part flex could not: a reflowed line starts in the fields
       track, because the label gutter is a different track entirely. */
    it('the strip REFLOWS rather than overflowing — "1 or 2 lines", never a clipped control', () => {
      const strip = ruleBody(chatControlsCss, '.pc-fleet-launch-row .pc-fleet-launch-row__fields');
      expect(strip).toMatch(/display:\s*grid/);
      // The label gutter is its OWN track — this is what makes it impossible
      // for a reflowed line to sit under the zone cap.
      expect(strip).toMatch(/grid-template-columns:\s*var\(--pc-ctl-gutter\)/);

      // auto-fit + a minimum column width is what drops the fields from three
      // columns to two to one as the popup narrows, instead of clipping.
      const fields = ruleBody(chatControlsCss, '.pc-fleet-strip__grid');
      expect(fields).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/);
    });

    /* The other half of the same fix, and the half a screenshot is worst at
       catching: two bands can each be internally tidy and still disagree with
       each other. They share one gutter only because they share one TOKEN. */
    it('both bottom-panel bands open on the SAME label-gutter track', () => {
      const controls = ruleBody(chatControlsCss, '.chat-action-bar.pc-ctl-band--do');
      const fleet = ruleBody(chatControlsCss, '.pc-fleet-launch-row .pc-fleet-launch-row__fields');
      for (const body of [controls, fleet]) {
        expect(body).toMatch(/display:\s*grid/);
        // The literal token, not a px value: two bands that each hard-code
        // their own width are the failure this is guarding against.
        expect(body).toMatch(/grid-template-columns:\s*var\(--pc-ctl-gutter\)/);
      }
    });

    /* Every field's caption occupies one shared track, so a well's x is set by
       its COLUMN and not by how long its own caption happens to be. Without
       this the band grid still leaves "Name" (27px) and "Account" (49px)
       starting their wells 22px apart inside perfectly aligned cells. */
    it('every inline field lays its caption in one SHARED track, so the wells line up', () => {
      const field = ruleBody(chatControlsCss, '.pc-ctl-field--inline');
      expect(field).toMatch(/display:\s*grid/);
      expect(field).toMatch(/grid-template-columns:\s*var\(--pc-ctl-cap-w\)/);
    });

    /* The Framed look (owner-approved 2026-08-02, artifact 6379bb65). This strip
       is the ONE band that does not act on the session you are looking at — it
       launches new ones — and that was the thing readers got wrong: it read as
       more session controls. The zone cap is what makes it legible, and it
       replaces a grey group caption rather than adding a row. */
    it('wears the Fleet zone cap, in place of the old grey group caption', () => {
      const { container } = renderRow(<FleetLaunchRow />);
      const cap = container.querySelector('.pc-zone-cap');
      expect(cap).toBeTruthy();
      expect(cap!.textContent).toBe('Fleet');
      // Still the strip's own leading element, i.e. the same row it always was —
      // the cap is a restyle of an existing label, not a new line of chrome.
      expect(cap!.classList.contains('pc-fleet-strip__label')).toBe(true);
    });

    it('draws the zone RULE above itself, so Fleet is bounded from the Controls band', () => {
      // jsdom applies no stylesheet, so this is a source assertion — the same
      // reason the split-owner guard above reads the CSS directly.
      const rule = chatControlsCss.split('}').find((b) => b.includes('.pc-fleet-launch-row {'));
      expect(rule).toMatch(/border-top:\s*1px solid var\(--pc-zone-rule\)/);
    });

    it('keeps every control NAMED despite the shorter visible captions (P-007 does not regress)', () => {
      renderRow(<FleetLaunchRow />);
      // The visible caption shortened to "Name"; the ACCESSIBLE name must still
      // be the full phrase, or a screen-reader user gets "Name" with no context
      // — which is the very complaint P-007 was filed for, re-created.
      expect(screen.getByLabelText('Fleet name')).toBeTruthy();
      expect(screen.getByLabelText('Plan the fleet works')).toBeTruthy();
      expect(screen.getByLabelText('Model for every fleet member')).toBeTruthy();
      expect(screen.getByLabelText('Account routing for every fleet member')).toBeTruthy();
      expect(screen.getByLabelText('Headed or headless members')).toBeTruthy();
      expect(screen.getByLabelText('Members')).toBeTruthy();
    });
  });
});
