// @vitest-environment jsdom
/**
 * NewSessionLauncher — the "+ New session" control lifted out of
 * AdvSessionsClient (hud-consolidation-2026-07-26 P-001) so the HUD board
 * header can reuse the same launch-from-plan-context path.
 *
 * Seams: Select/useLexicon/plans-api/launch-agent/sonner stubbed — same
 * pattern as PlanActions.test.tsx and AgentLauncherButton.test.tsx.
 * Uses @testing-library/react + vitest only (no jest-dom matchers) — see
 * those files' identical note; jest-dom's Chai plugin isn't registered in
 * this workspace's vitest setup, so `.toBeDisabled()` throws
 * "Invalid Chai property" rather than failing the assertion (WI-5963).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

/** Mirrors the useful part of launchAgent's result union. Declared explicitly
 *  because inferring it from the default implementation narrows to
 *  `{ ok: true }`, which then rejects every mockResolvedValueOnce for the
 *  warning and failure paths below. */
type LaunchResult = {
  ok: boolean;
  warning?: string;
  error?: string;
  installCmd?: string;
  /** WI-6363: the pre-pinned coord owner id launch-su returns. NOTE the shape
   *  here must track the REAL endpoint — the bug this guards existed because
   *  the old fixture supplied an `advSessionId` the live response never sends,
   *  so `onLaunched` was asserted to have FIRED but never with WHAT. */
  ownerId?: string;
};

const h = vi.hoisted(() => ({
  planListData: { plans: [] as Array<Record<string, unknown>>, loading: false },
  launchAgent: vi.fn(async (_opts: unknown): Promise<LaunchResult> => ({ ok: true })),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  /** WI-6321: what psu's options endpoint would return. Empty by default — the
   *  picker must render and launch with no fleets and no gateway pool. */
  launchOptions: {
    fleets: [] as Array<{ slug: string; title: string | null; color?: { name?: string } | null }>,
    nextScheme: null as { name: string } | null,
    schemes: [] as Array<{ name: string; bg: string; fg: string; cursor: string }>,
    accounts: [] as Array<{ id: string; label?: string | null; detail?: string | null }>,
    ompCatalog: {
      status: 'available' as const,
      availability: 'enabled-configured' as const,
      credentials: 'unchecked' as const,
      upstream: 'unchecked' as const,
      error: null,
      models: [{
        provider: 'openai-codex',
        id: 'gpt-5.6-terra',
        selector: 'openai-codex/gpt-5.6-terra',
        name: 'GPT-5.6-Terra',
        contextWindow: 200_000,
        maxTokens: 128_000,
        reasoning: true,
        thinking: ['low', 'medium', 'high', 'xhigh', 'max'],
        input: ['text' as const, 'image' as const],
        cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      }],
    },
  },
  optionsRefresh: vi.fn(),
  identityCatalog: {
    identities: [] as Array<{ id: string; tier: string; version: string; sourceRevision: string;
      slots: Array<{ slot: string; cardinality: 'exclusive' }>;
      launchCompatibility?: { eligible: boolean; reason: string | null } }>,
    unreadable: [] as Array<{ id: string; error: string }>,
    nextAfter: null as string | null,
  },
  identityLoadMore: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: h.toastSuccess, error: h.toastError, warning: h.toastWarning },
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
// WI-37871: spread the REAL module rather than listing exports. This mock used
// to return `{ launchAgent }` alone, which silently made every OTHER export
// `undefined` inside the component — so `headless: OWNER_LAUNCH_HEADLESS` would
// have arrived as `undefined` and the headless assertion below could not fail
// for the right reason. Keeping the original module means the test pins the REAL
// constant: flip it to `false` in launch-agent.ts and this suite goes red.
vi.mock('@papercusp/operator-core/lib/launch-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/operator-core/lib/launch-agent')>()),
  launchAgent: (opts: unknown) => h.launchAgent(opts),
}));
vi.mock('@/app/admin/plans/plans-api', () => ({
  usePlanList: () => ({ data: { plans: h.planListData.plans }, loading: h.planListData.loading }),
}));
// WI-6321: the fleet/account picker source hits psu's own options endpoint over
// HTTP. Stubbed so these stay LAUNCHER tests (which options reach launchAgent)
// and never depend on a running operator — the hook's own fail-soft + payload
// normalization are covered in use-su-launch-options.test.ts.
vi.mock('./use-su-launch-options', () => ({
  useSuLaunchOptions: () => ({
    fleets: h.launchOptions.fleets,
    nextScheme: h.launchOptions.nextScheme,
    schemes: h.launchOptions.schemes,
    accounts: h.launchOptions.accounts,
    ompCatalog: h.launchOptions.ompCatalog,
    loading: false,
    error: null,
    refresh: h.optionsRefresh,
  }),
  useIdentityLaunchCatalog: () => ({ ...h.identityCatalog, loading: false, error: null,
    loadMore: h.identityLoadMore }),
}));
// The pickers became searchable Comboboxes under
// `hud-session-launcher-and-board-tabs-2026-07-26` P-003. Stubbed to a native
// <select> (which also reports role="combobox") so these tests keep exercising
// LAUNCHER logic — which plan/model/effort reaches launchAgent — rather than
// re-testing the combobox. The combobox's own behaviour (full list on focus,
// filter as you type, scroll container, detail rows) is covered for real in
// app/harness/__tests__/Combobox.test.tsx.
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
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {flat.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  },
}));

import NewSessionLauncher, {
  buildAccountOptions,
  buildContextSizeOptions,
  buildFleetOptions,
  buildModeOptions,
  buildModelOptions,
  buildEffortOptions,
  MODE_SELECT_NONE,
  composeModelSpec,
  modelBackend,
  ACCOUNT_SELECT_DEFAULT,
  CONTEXT_SELECT_NATIVE,
  FLEET_SELECT_NEW,
  FLEET_SELECT_NONE,
  PLAN_SELECT_PLACEHOLDER,
  OMP_MODEL_OPTIONS,
  EFFORT_OPTIONS,
  MODEL_SELECT_DEFAULT,
  EFFORT_SELECT_DEFAULT,
} from './NewSessionLauncher';
import {
  CLOUD_MODEL_MENU,
  MODEL_EFFORT_LEVELS,
  SU_CONTEXT_SIZES,
} from '@papercusp/operator-core/lib/agent-config-constants';
// P-042: assert the picker against the SHARED source it renders from, not a
// local copy — a copy would satisfy the row-count check while still drifting.
import {
  LAUNCHABLE_MODE_IDS,
  isLaunchableMode,
} from '@papercusp/operator-core/lib/modes/registry';

function plan(slug: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    slug,
    title: `Title for ${slug}`,
    status: 'active',
    updated: null,
    owner: null,
    archived: false,
    isLegacy: false,
    itemCounts: null,
    nextAction: null,
    harness: 'papercusp',
    ...over,
  };
}

beforeEach(() => {
  h.planListData = { plans: [plan('alpha-plan'), plan('beta-plan')], loading: false };
  h.launchAgent.mockReset().mockResolvedValue({ ok: true });
  h.toastSuccess.mockReset();
  h.toastError.mockReset();
  h.toastWarning.mockReset();
  h.identityCatalog.identities = [];
  h.identityCatalog.unreadable = [];
  h.identityCatalog.nextAfter = null;
  h.identityLoadMore.mockReset();
});

describe('selected identity launch', () => {
  it('offers SU by default, shows invalid entries, and forwards a selected source pin', async () => {
    const revision = 'a'.repeat(64);
    h.identityCatalog.identities = [{ id: 'research-steward', tier: 'installed', version: '1.2.0',
      sourceRevision: revision, slots: [{ slot: 'domain', cardinality: 'exclusive' }] }];
    h.identityCatalog.unreadable = [{ id: 'broken', error: 'attestation-missing' }];
    const { buildIdentityLaunchOptions } = await import('./NewSessionLauncher');
    expect(buildIdentityLaunchOptions(h.identityCatalog)).toContainEqual(expect.objectContaining({
      value: 'invalid:broken', disabled: true,
      detail: 'Invalid: attestation-missing',
    }));
    expect(buildIdentityLaunchOptions({ ...h.identityCatalog, identities: [{
      id: 'needs-producer', tier: 'installed', version: '1.0.0', sourceRevision: revision,
      slots: [{ slot: 'domain', cardinality: 'exclusive' }],
      launchCompatibility: { eligible: false, reason: 'Needs live producer binding' },
    }] })).toContainEqual(expect.objectContaining({ value: 'domain:needs-producer', disabled: true }));
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    const identity = screen.getByRole('combobox', { name: 'Identity for new session' });
    expect((identity as HTMLSelectElement).value).toBe('su');
    fireEvent.change(identity, { target: { value: 'domain:research-steward' } });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledWith(expect.objectContaining({
      stack: ['domain:research-steward'], selectedIdentityRevision: revision,
    })));
  });
  it('forwards a named composition root and its closure revision', async () => {
    const revision = 'b'.repeat(64);
    h.identityCatalog.identities = [{ id: 'named-review', tier: 'local', version: '1.0.0',
      sourceRevision: revision, slots: [],
      launchCompatibility: { eligible: true, reason: null } }];
    const { buildIdentityLaunchOptions } = await import('./NewSessionLauncher');
    expect(buildIdentityLaunchOptions(h.identityCatalog)).toContainEqual(expect.objectContaining({
      value: 'composition:named-review', disabled: false,
    }));
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Identity for new session' }),
      { target: { value: 'composition:named-review' } });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledWith(expect.objectContaining({
      stack: ['composition:named-review'], selectedIdentityRevision: revision,
    })));
  });
});
afterEach(() => cleanup());

// WI-6300 (owner ask 2026-07-27). These lists used to be hand-maintained literals
// that drifted behind psu: 4 of 7 models (no fable/sol/terra/luna) plus a stale
// `gpt-5.2`, and 3 of 5 efforts (no xhigh/max). They are now DERIVED, and the
// cross-file guard that CLOUD_MODEL_MENU / MODEL_EFFORT_LEVELS still match psu's
// own menus lives in apps/operator/lib/psu-launcher.test.ts. What this suite pins
// is the second half of the chain: that the pickers actually render everything
// those constants offer, so a future "tidy-up" can't quietly re-hardcode a subset.
describe('model + effort options are derived from the psu vocabulary (WI-6300)', () => {
  it('offers every psu base model, plus the explicit Default row', () => {
    expect(OMP_MODEL_OPTIONS.map((o) => o.value)).toEqual([
      MODEL_SELECT_DEFAULT,
      ...CLOUD_MODEL_MENU.map((m) => m.value),
    ]);
  });

  it('groups the seven native aliases separately from exact OMP selectors', () => {
    const options = buildModelOptions(h.launchOptions.ompCatalog.models);
    const groups = options.filter((option) => 'kind' in option);
    expect(groups.map((group) => group.label)).toEqual(['Papercusp aliases', 'OMP installed models']);
    expect(groups[0].options.map((option) => option.value)).toEqual(CLOUD_MODEL_MENU.map((m) => m.value));
    expect(groups[1].options[0]).toMatchObject({
      value: 'openai-codex/gpt-5.6-terra',
      label: 'GPT-5.6-Terra',
    });
  });

  it('uses OMP model-specific thinking levels', () => {
    expect(buildEffortOptions(h.launchOptions.ompCatalog.models[0]).map((option) => option.value)).toEqual([
      EFFORT_SELECT_DEFAULT,
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(buildEffortOptions({ ...h.launchOptions.ompCatalog.models[0], thinking: null })).toEqual([
      EFFORT_OPTIONS[0],
    ]);
  });

  it('includes the four models the old hand-written list was missing', () => {
    const values = OMP_MODEL_OPTIONS.map((o) => o.value);
    for (const missing of ['fable', 'sol', 'terra', 'luna']) {
      expect(values, missing).toContain(missing);
    }
  });

  it('no longer offers gpt-5.2 — it is not a psu-recognized alias', () => {
    expect(OMP_MODEL_OPTIONS.map((o) => o.value)).not.toContain('gpt-5.2');
  });

  it('labels each model with the CLI it launches, so a codex pick is not mistaken for claude', () => {
    for (const m of CLOUD_MODEL_MENU) {
      const opt = OMP_MODEL_OPTIONS.find((o) => o.value === m.value);
      expect(opt?.detail, m.value).toBe(m.backend === 'codex' ? 'codex CLI' : 'claude CLI');
    }
  });

  it('offers every psu effort level including xhigh and max, plus the Default row', () => {
    expect(EFFORT_OPTIONS.map((o) => o.value)).toEqual([
      EFFORT_SELECT_DEFAULT,
      ...MODEL_EFFORT_LEVELS,
    ]);
    expect(EFFORT_OPTIONS.map((o) => o.value)).toContain('xhigh');
    expect(EFFORT_OPTIONS.map((o) => o.value)).toContain('max');
  });

  it('every effort row renders a non-empty label — a new psu level falls back to its token, never blank', () => {
    for (const o of EFFORT_OPTIONS) expect(o.label?.trim(), o.value).toBeTruthy();
  });

  it('every offered model×effort pair composes to the spec psu expects', () => {
    for (const m of CLOUD_MODEL_MENU) {
      for (const e of MODEL_EFFORT_LEVELS) {
        expect(composeModelSpec(m.value, e)).toBe(`${m.value}:${e}`);
      }
      // effort left at Default ⇒ bare model, no dangling colon
      expect(composeModelSpec(m.value, '')).toBe(m.value);
    }
  });
});

describe('NewSessionLauncher', () => {
  it('renders a plan picker, a model picker, and an ENABLED launch button by default', () => {
    // P-005 (owner ask 2026-07-26): "You should be able to launch a session
    // with no plan selected." This assertion previously required the button to
    // be DISABLED until a plan was chosen — that was the requirement the owner
    // reversed, so the inverted expectation here is the point of the change.
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    expect(screen.getByRole('combobox', { name: 'Plan for new session' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Model for new session' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '+ New session' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('launches with NO plan selected, passing planSlug: null', async () => {
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />, { wrapper: withNuqsTestingAdapter() });
    // Deliberately choose nothing — the placeholder is still selected.
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    // WI-6321 added the psu-parity options to every launch, so this asserts the
    // fields it is about rather than the whole envelope; the parity defaults get
    // their own test below.
    expect(h.launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: null,
        planSlug: null,
        label: 'su session',
        model: null,
      }),
    );
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.toastError).not.toHaveBeenCalled();
    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  /**
   * WI-6321 (owner ask 2026-07-27). The toast used to read `Agent launched for <label>`,
   * and with a plan selected `label` IS the plan title — so a descriptive title rendered
   * as "Agent launched for Arrow-format sync reads, then an mmap'd Arrow read cache." and
   * read as a garbled sentence. The owner had to ask what it meant. The message must name
   * the KIND of thing the label is, and quote it so a long title is visibly a title.
   */
  describe('toast names the plan AS a plan (owner ask 2026-07-27)', () => {
    it('with a plan: says `on plan "<title>"`, not `for <title>`', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
        target: { value: 'beta-plan' },
      });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
      const msg = String(h.toastSuccess.mock.calls.at(-1)?.[0] ?? '');
      expect(msg).toContain('on plan');
      expect(msg).not.toContain('launched for');
    });

    it('with NO plan: says it is a plain su session rather than naming a phantom plan', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
      const msg = String(h.toastSuccess.mock.calls.at(-1)?.[0] ?? '');
      expect(msg).toContain('su session');
      expect(msg).not.toContain('on plan');
    });
  });

  /**
   * OWNER BUG 2026-07-27 ("when I launch the new session the console shows up and then
   * disappears"). The model picker lists the WHOLE CLOUD_MODEL_MENU, which spans backends,
   * but the launch sent no `agent` — so launch-su used the configured default (claude) and
   * psu refused: "model `sol` belongs to the `codex` backend, but this launch requested
   * `--agent=claude`". psu prints that and exits 0 BEFORE writing its adv_sessions row, so
   * the window flashed shut, nothing was recorded, and the caller still showed SUCCESS.
   * Reproduced directly:
   *   psu --no-picker --agent=claude --no-plan --model=sol  → that message, exit 0, instant.
   */
  describe('the picked model carries its backend (owner bug 2026-07-27)', () => {
    const launchWithModel = async (value: string) => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.change(screen.getByRole('combobox', { name: 'Model for new session' }), {
        target: { value },
      });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
      return h.launchAgent.mock.calls.at(-1)?.[0] as { agent?: string; model?: string | null };
    };

    it('a codex model launches the CODEX agent, not the default claude', async () => {
      expect((await launchWithModel('sol')).agent).toBe('codex');
    });

    it('a claude model launches the claude agent', async () => {
      expect((await launchWithModel('opus')).agent).toBe('claude');
    });

    it('an OMP catalog model launches omp with the exact provider/id selector', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.change(screen.getByRole('combobox', { name: 'Model for new session' }), {
        target: { value: 'openai-codex/gpt-5.6-terra' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: 'Effort level for new session' }), {
        target: { value: 'xhigh' },
      });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
      expect(h.launchAgent).toHaveBeenCalledWith(expect.objectContaining({
        agent: 'omp',
        model: 'openai-codex/gpt-5.6-terra:xhigh',
      }));
    });

    it('no model chosen sends NO agent, leaving the configured default intact', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
      const call = h.launchAgent.mock.calls.at(-1)?.[0] as { agent?: string };
      expect(call.agent).toBeUndefined();
    });

    it('modelBackend covers every menu entry and tolerates a <model>:<effort> spec', () => {
      for (const m of CLOUD_MODEL_MENU) {
        expect(modelBackend(m.value)).toBe(m.backend);
        expect(modelBackend(`${m.value}:high`)).toBe(m.backend);
      }
      expect(modelBackend('')).toBeUndefined();
      expect(modelBackend('not-a-model')).toBeUndefined();
      expect(modelBackend('amazon-bedrock/anthropic.claude-3-5-haiku-20241022-v1:0')).toBe('omp');
    });
  });

  it('enables the button once a plan is chosen, and launches with the selected plan', async () => {
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
      target: { value: 'beta-plan' },
    });
    const btn = screen.getByRole('button', { name: '+ New session' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    expect(h.launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: null,
        planSlug: 'beta-plan',
        label: 'Title for beta-plan',
        model: null,
      }),
    );
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled());
    expect(h.toastError).not.toHaveBeenCalled();
    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  it('threads a non-default model choice through to launchAgent', async () => {
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
      target: { value: 'alpha-plan' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model for new session' }), {
      target: { value: 'opus' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    expect(h.launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'alpha-plan', model: 'opus' }),
    );
  });

  // EI-18696184925888288: launch-su can report ok:true with a `warning` when
  // the spawned terminal process exited almost immediately (a likely silent
  // no-op) — the UI must say so rather than a flat success toast.
  it('toasts a warning (not success) when launchAgent reports ok:true with a warning', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: true, warning: 'the spawned terminal process exited almost immediately' });
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
      target: { value: 'alpha-plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.toastWarning).toHaveBeenCalledTimes(1));
    expect(h.toastSuccess).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
    // onLaunched still fires — the session row genuinely may exist; the
    // warning is advisory, not a hard failure.
    expect(onLaunched).toHaveBeenCalledTimes(1);
  });

  // WI-6363 REGRESSION GUARD. The bug: this callback carried `advSessionId`,
  // which launch-su's terminal path never returns (it records no adv_sessions
  // row — psu self-registers one later), so onLaunched always fired with null
  // and the HUD chat never opened. The old tests missed it because they only
  // asserted onLaunched had been CALLED, never with WHAT — so assert the value.
  it('hands the pre-pinned coord owner id to onLaunched (not a row id)', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: true, ownerId: 'su-11111111-2222-3333-4444-555555555555' });
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onLaunched).toHaveBeenCalledWith('su-11111111-2222-3333-4444-555555555555');
  });

  // Non-vacuity companion: an operator that predates the pre-pin returns no
  // ownerId, and we must pass null rather than invent a handle — a caller keys
  // a chat off this, so a wrong-but-truthy value would open the WRONG session.
  it('passes null to onLaunched when the launch response carries no ownerId', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: true });
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1));
    expect(onLaunched).toHaveBeenCalledWith(null);
  });

  it('keeps a visible headless launch receipt with the returned owner id', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: true, ownerId: 'su-headless-1' });
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    const status = await screen.findByTestId('new-session-launch-status');
    expect(status.textContent).toContain('Headless launch recorded');
    expect(status.textContent).toContain('su-headless-1');
    expect(status.textContent).toContain('No console window is opened');
  });

  it('keeps the receipt legible when an older launch response has no owner id', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: true });
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    const status = await screen.findByTestId('new-session-launch-status');
    expect(status.textContent).toContain('owner id is still starting');
  });

  it('counts repeated launches and offers the caller a Sessions-board action', async () => {
    h.launchAgent
      .mockResolvedValueOnce({ ok: true, ownerId: 'su-headless-1' })
      .mockResolvedValueOnce({ ok: true, ownerId: 'su-headless-2' });
    const onViewSessions = vi.fn();
    render(<NewSessionLauncher onViewSessions={onViewSessions} />, {
      wrapper: withNuqsTestingAdapter(),
    });
    const launchButton = screen.getByRole('button', { name: '+ New session' });
    fireEvent.click(launchButton);
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    fireEvent.click(launchButton);
    const status = await screen.findByTestId('new-session-launch-status');
    expect(status.textContent).toContain('2 headless agents launched');
    expect(screen.getByRole('button', { name: 'View sessions' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View sessions' }));
    expect(onViewSessions).toHaveBeenCalledTimes(1);
  });

  it('toasts an error and does not call onLaunched when launchAgent fails', async () => {
    h.launchAgent.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const onLaunched = vi.fn();
    render(<NewSessionLauncher onLaunched={onLaunched} />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Plan for new session' }), {
      target: { value: 'alpha-plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(h.toastError.mock.calls[0][0]).toContain('boom');
    expect(onLaunched).not.toHaveBeenCalled();
  });

  // P-008 (owner ask 2026-07-26): "add another box with search/filter/dropdown
  // behavior … to select the effort level."
  it('renders an effort picker and folds the choice into the model spec', async () => {
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model for new session' }), {
      target: { value: 'opus' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Effort level for new session' }), {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    expect(h.launchAgent).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus:high' }));
  });

  /**
   * WI-6321 (owner ask 2026-07-27: the GUI "should share the same code for getting
   * the options"). A bare effort with no model used to be DROPPED silently — the
   * launcher's own private composeModelSpec returned null and the session launched
   * at the backend's default effort with nothing said. That is the drift the shared
   * source removes: `composeLaunchModelSpec` throws (psu has no standalone effort
   * flag, so there is nowhere for it to go) and the launcher SHOWS it.
   *
   * The old expectation — launch anyway with `model: null` — is deliberately
   * inverted here: refusing to launch is the fix, not a regression.
   */
  it('REFUSES a bare effort with no model, and says so instead of dropping it', async () => {
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    fireEvent.change(screen.getByRole('combobox', { name: 'Effort level for new session' }), {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    expect(String(h.toastError.mock.calls[0]?.[0])).toMatch(/needs a model/);
    // The launch must NOT have happened — a silently-wrong session is the bug.
    expect(h.launchAgent).not.toHaveBeenCalled();
  });

  it('composeModelSpec joins model and effort, and refuses effort-without-model', () => {
    expect(composeModelSpec('sonnet', 'high')).toBe('sonnet:high');
    expect(composeModelSpec('sonnet', '')).toBe('sonnet');
    expect(composeModelSpec('', '')).toBe(null);
    expect(composeModelSpec('  sonnet  ', '  high  ')).toBe('sonnet:high');
    // Was `toBe(null)` — the silent drop. Now an explicit refusal.
    expect(() => composeModelSpec('', 'high')).toThrow(/needs a model/);
  });

  /**
   * WI-6321 — the psu-parity options the GUI could not previously express. The
   * owner's ask was that the panel carry "all the same options as the psu
   * utility"; these assert the wire values a default launch now sends.
   */
  describe('psu-parity launch options (WI-6321)', () => {
    it('renders the fleet, account and context-size pickers', () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      expect(screen.getByRole('combobox', { name: 'Fleet for new session' })).toBeTruthy();
      expect(screen.getByRole('combobox', { name: 'Account for new session' })).toBeTruthy();
      expect(screen.getByRole('combobox', { name: 'Context size for new session' })).toBeTruthy();
    });

    it('ALWAYS sends an account — psu with none opens a picker that would hang the spawn', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
      expect(h.launchAgent).toHaveBeenCalledWith(expect.objectContaining({ account: 'default' }));
    });

    it('ALWAYS launches HEADLESS — no console window, with no toggle to get one', async () => {
      // WI-37871 [owner 2026-08-11, interactive]: "Always headless. same for new
      // goal". Asserting the literal `true` rather than OWNER_LAUNCH_HEADLESS on
      // purpose: comparing the value against itself would pass however the
      // constant is defined, which is exactly the assertion that cannot fail.
      // The import is un-mocked (see the vi.mock above), so this reds if anyone
      // flips the constant, drops the field, or makes it conditional.
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
      expect(h.launchAgent).toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
    });

    it('offers the owner NO headed/headless control — the rejected toggle must not come back', () => {
      // The owner was offered a toggle and picked always-headless instead. A
      // reintroduced picker would satisfy the assertion above (it can still
      // default to headless) while breaking the actual directive, so pin the
      // ABSENCE too. Scoped to this launcher — FleetLaunchRow's headed/headless
      // picker is a separate, owner-approved surface and stays.
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      const labels = screen
        .getAllByRole('combobox')
        .map((el) => el.getAttribute('aria-label') ?? '');
      expect(labels.some((l) => /headless|headed|window|terminal|console/i.test(l))).toBe(false);
    });

    it('sends no fleet and no context-size override by default (unchanged launch)', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
      expect(h.launchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ fleet: null, fleetName: null, contextSize: undefined }),
      );
    });

    it('threads a chosen context size through as the psu --context-size value', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.change(screen.getByRole('combobox', { name: 'Context size for new session' }), {
        target: { value: 'trimmed' },
      });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
      expect(h.launchAgent).toHaveBeenCalledWith(expect.objectContaining({ contextSize: 'trimmed' }));
    });

    it('refuses to create a fleet with no name rather than launching unfleeted', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.change(screen.getByRole('combobox', { name: 'Fleet for new session' }), {
        target: { value: FLEET_SELECT_NEW },
      });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.toastError).toHaveBeenCalled());
      expect(h.launchAgent).not.toHaveBeenCalled();
    });

    it('builds the fleet rows psu offers: no-fleet, create-new, then each existing fleet', () => {
      const opts = buildFleetOptions(
        [{ slug: 'alpha', title: 'Alpha', color: { name: 'ember' } }],
        'cobalt',
      );
      expect(opts.map((o) => o.value)).toEqual([FLEET_SELECT_NONE, FLEET_SELECT_NEW, 'alpha']);
      // The create row previews the colour a new fleet would actually get.
      expect(opts[1].detail).toMatch(/cobalt/);
      expect(opts[2].detail).toMatch(/ember/);
    });

    it('builds account rows: psu\'s two modes first, then any gateway pool accounts', () => {
      const opts = buildAccountOptions([{ id: 'pool-1', label: 'Pool one' }]);
      expect(opts.map((o) => o.value)).toEqual(['default', 'auto', 'pool-1']);
    });

    it('offers Native plus exactly psu\'s context-size variants', () => {
      expect(buildContextSizeOptions().map((o) => o.value)).toEqual([
        CONTEXT_SELECT_NATIVE,
        ...SU_CONTEXT_SIZES,
      ]);
    });
  });

  /**
   * retire-mug-kettle-su-only-2026-08-09 P-042 (D-067) — the launch-time MODE.
   *
   * With the Mug/Kettle tier retired, su + its modes ARE how the app is driven.
   * GOAL already had an atomic GUI surface (GoalComposer, P-041); AUTO and DRAIN
   * had none, so the only way into either was typing it to a session that was
   * already running.
   */
  describe('launch-time mode picker (P-042)', () => {
    it('renders the mode picker', () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      expect(screen.getByRole('combobox', { name: 'Mode for new session' })).toBeTruthy();
    });

    it('defaults to AUTO for the always-headless unbound launch', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
      expect(h.launchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'auto', headless: true, planSlug: null }),
      );
    });

    it('keeps Interactive as an explicit opt-out', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.change(screen.getByRole('combobox', { name: 'Mode for new session' }), {
        target: { value: MODE_SELECT_NONE },
      });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
      expect(h.launchAgent).toHaveBeenCalledWith(
        expect.objectContaining({ mode: null, headless: true }),
      );
    });

    it('threads a chosen mode through to the launch', async () => {
      render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
      fireEvent.change(screen.getByRole('combobox', { name: 'Mode for new session' }), {
        target: { value: 'drain' },
      });
      fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
      await waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
      expect(h.launchAgent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'drain' }));
    });

    it('offers Interactive plus exactly the registry\'s launchable modes', () => {
      expect(buildModeOptions().map((o) => o.value)).toEqual([
        MODE_SELECT_NONE,
        ...LAUNCHABLE_MODE_IDS,
      ]);
    });

    /**
     * The picker is rendered FROM the registry so it cannot offer a mode
     * launch-su would refuse. Asserting the shared source directly is what makes
     * that claim testable — a local copy would satisfy the row-count check above
     * while still drifting.
     */
    it('offers nothing psu cannot launch — every row but Interactive is launchable', () => {
      for (const o of buildModeOptions()) {
        if (o.value === MODE_SELECT_NONE) continue;
        expect(isLaunchableMode(o.value)).toBe(true);
      }
    });

    it('never offers GOAL — it requires a subject and has its own atomic surface', () => {
      expect(buildModeOptions().map((o) => o.value)).not.toContain('goal');
    });

    it('every row is renderable — a blank label would be an unpickable row', () => {
      for (const o of buildModeOptions()) {
        expect(o.label.trim().length).toBeGreaterThan(0);
        const detail = o.detail;
        expect(typeof detail).toBe('string');
        expect((typeof detail === 'string' ? detail : '').trim().length).toBeGreaterThan(0);
      }
    });
  });

  it('the plan picker default value is the placeholder sentinel with no selection', () => {
    render(<NewSessionLauncher />, { wrapper: withNuqsTestingAdapter() });
    const select = screen.getByRole('combobox', {
      name: 'Plan for new session',
    }) as HTMLSelectElement;
    expect(select.value).toBe(PLAN_SELECT_PLACEHOLDER);
  });
});
