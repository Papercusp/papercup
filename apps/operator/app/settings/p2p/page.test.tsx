// @vitest-environment jsdom
/**
 * /settings/p2p — P2P work-sharing owner surface render test
 * (p2p-work-distribution-2026-07-02 P-002: "a page render test").
 *
 * Pins the render-side contracts of the page that matter for the P-002 spec —
 * the "loud, never silent" invariants — without a real Tauri shell:
 *   - the page shell + every labelled section renders (kill-switch, identity &
 *     devices, peers, work opt-in, budgets, foreign-work-NOW, audit);
 *   - GLOBAL KILL-SWITCH reflects engaged vs clear state loudly;
 *   - Identity is LOUD when unresolved (IDENTITY UNRESOLVED badge) and when a
 *     hive attestation is MISSING (never a silent gap);
 *   - Peers renders a LOUD pending state when no hive is resolved;
 *   - the shipped P-201 budget surface links to Resources and the shipped
 *     P-104 host-local registry renders loading/error/empty/populated states;
 *   - Audit shows the empty state and a populated row;
 *   - a settings load error surfaces an alert (never a silent blank).
 *
 * Seams: @papercusp/sync (useSyncQuery/useSyncMutate) + nuqs + sonner +
 * the Radix-backed harness Select/Checkbox are module-mocked; real drag /
 * Radix pointer mechanics are exercised by the Tauri e2e surface, not jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/* ── Hoisted mutable holder the sync factory closes over ── */
const h = vi.hoisted(() => ({
  settings: undefined as unknown,
  devices: undefined as unknown,
  audit: undefined as unknown,
  grants: undefined as unknown,
  foreignWorkspaces: undefined as unknown,
  errors: {} as Record<string, Error | null>,
  loadings: {} as Record<string, boolean>,
  lastArgs: {} as Record<string, unknown>,
  invalidate: vi.fn(),
  mutate: vi.fn(async (_args: unknown) => ({ ok: true })),
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (q: { queryName: string; args?: unknown }) => {
    h.lastArgs[q.queryName] = q.args;
    const data =
      q.queryName === 'p2p.settings'
        ? h.settings
        : q.queryName === 'p2p.devices'
          ? h.devices
          : q.queryName === 'p2p.audit'
            ? h.audit
            : q.queryName === 'p2p.grants'
              ? h.grants
              : q.queryName === 'p2p.foreignWorkspaces'
                ? h.foreignWorkspaces
              : undefined;
    return {
      data,
      error: h.errors[q.queryName] ?? null,
      loading: h.loadings[q.queryName] ?? false,
      fetching: false,
      invalidate: h.invalidate,
    };
  },
  useSyncMutate: () => h.mutate,
}));

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => {
  const withDefault = (d: unknown) => ({ defaultValue: d });
  return {
    ...nuqsParsers,
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

// Radix-backed harness controls → simple native stand-ins (jsdom-safe; keeps
// the render test about the PAGE, not the Select internals).
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
    options: { value: string; label: string }[];
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('../../harness/Checkbox', () => ({
  Checkbox: ({
    checked,
    onChange,
    ariaLabel,
  }: {
    checked: boolean;
    onChange: (c: boolean) => void;
    ariaLabel?: string;
  }) => (
    <input type="checkbox" aria-label={ariaLabel} checked={checked} onChange={(e) => onChange(e.target.checked)} />
  ),
}));

// Lexicon resolver echoes its key (t('pot') → 'pot') — isolates the hive→pot
// routed copy from the THE_HIVE flag hook (restore-pot-lexicon-public-release P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import P2pSettingsPage from './page';

/* ── Fixtures ── */
const baseSettings = {
  optIn: { mode: 'off' as const, fleets: [] as string[], maxConcurrentForeign: 2, windows: [] as unknown[] },
  killSwitch: { engaged: false, engagedAtMs: null as number | null, reason: null as string | null, windDownGraceSec: 30 },
};
const mkLayers = (over: Partial<typeof baseSettings> = {}) => {
  const effective = { ...baseSettings, ...over };
  return [{ workspaceId: 'ws1', baked: baseSettings, defaultLayer: null, overrideLayer: null, effective }];
};

const identityRow = { kind: 'identity', githubUserId: 279242982, devicePubkey: 'IXfGu216EIz1gNQabcdefgh0123456789ZZ' };
const unavailable = (reason: string, kind: 'pre-migration' | 'read-failed' = 'read-failed') => ({
  kind: 'unavailable',
  unavailable: true,
  unavailableKind: kind,
  unavailableReason: reason,
});

beforeEach(() => {
  h.settings = mkLayers();
  h.devices = [];
  h.audit = [];
  h.grants = [];
  h.foreignWorkspaces = [];
  h.errors = {};
  h.loadings = {};
  h.lastArgs = {};
  h.mutate.mockClear();
  h.invalidate.mockClear();
});
afterEach(cleanup);

describe('/settings/p2p render', () => {
  it('renders the page shell + every labelled section', () => {
    render(<P2pSettingsPage />);
    expect(screen.getByRole('heading', { level: 1, name: /P2P work sharing/i })).toBeTruthy();
    for (const label of [
      'Global kill-switch',
      'Identity and devices',
      'Peers',
      'Work opt-in',
      'Budgets',
      'Foreign work running now',
      'P2P audit trail',
    ]) {
      expect(screen.getByRole('region', { name: label }), `section "${label}" missing`).toBeTruthy();
    }
  });

  it('shows the kill-switch CLEAR state by default', () => {
    render(<P2pSettingsPage />);
    const ks = screen.getByRole('region', { name: 'Global kill-switch' });
    expect(within(ks).getByText(/clear/i)).toBeTruthy();
    expect(within(ks).getByRole('button', { name: /Engage kill-switch/i })).toBeTruthy();
  });

  it('shows the kill-switch ENGAGED state loudly when engaged', () => {
    h.settings = mkLayers({
      killSwitch: { engaged: true, engagedAtMs: 1_700_000_000_000, reason: 'maintenance', windDownGraceSec: 30 },
    });
    render(<P2pSettingsPage />);
    const ks = screen.getByRole('region', { name: 'Global kill-switch' });
    expect(within(ks).getByText(/ENGAGED — all foreign work paused/i)).toBeTruthy();
    expect(within(ks).getByText(/maintenance/)).toBeTruthy();
    expect(within(ks).getByRole('button', { name: /Disengage/i })).toBeTruthy();
  });

  it('shows kill-switch STATE UNKNOWN and disables settings mutations for a degraded snapshot', () => {
    h.settings = [{ ...mkLayers()[0], ...unavailable('relation "p2p_settings" does not exist', 'pre-migration') }];
    render(<P2pSettingsPage />);
    const ks = screen.getByRole('region', { name: 'Global kill-switch' });
    expect(within(ks).getByText(/STATE UNKNOWN — settings unavailable/i)).toBeTruthy();
    expect(within(ks).queryByText(/^clear$/i)).toBeNull();
    expect((within(ks).getByRole('button', { name: /Engage kill-switch/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Apply starter profile/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/relation "p2p_settings" does not exist/i);
  });

  it('is LOUD when identity is unresolved (no attested identity)', () => {
    h.devices = []; // no identity row at all
    render(<P2pSettingsPage />);
    expect(screen.getByText(/IDENTITY UNRESOLVED/i)).toBeTruthy();
  });

  it('renders device-read unavailability as unknown rather than no memberships', () => {
    h.devices = [unavailable('membership replica unavailable')];
    render(<P2pSettingsPage />);
    const identity = screen.getByRole('region', { name: 'Identity and devices' });
    expect(within(identity).getByRole('alert').textContent).toMatch(/membership replica unavailable/i);
    expect(within(identity).queryByText(/IDENTITY UNRESOLVED/i)).toBeNull();
    const peers = screen.getByRole('region', { name: 'Peers' });
    expect(within(peers).getByRole('alert').textContent).toMatch(/Memberships are unavailable/i);
    expect(within(peers).queryByText(/No pot memberships resolved/i)).toBeNull();
  });

  it('surfaces the resolved GitHub identity + a MISSING attestation badge', () => {
    h.devices = [identityRow, { kind: 'missing', potHomeSlug: 'papercusp' }];
    render(<P2pSettingsPage />);
    const id = screen.getByRole('region', { name: 'Identity and devices' });
    expect(within(id).getByText(String(identityRow.githubUserId))).toBeTruthy();
    expect(within(id).getByText(/MISSING/)).toBeTruthy();
    expect(within(id).getByText(/papercusp/)).toBeTruthy();
  });

  it('renders a LOUD pending state in Peers when no hive is resolved', () => {
    h.devices = [identityRow]; // identity but no hive membership rows
    render(<P2pSettingsPage />);
    const peers = screen.getByRole('region', { name: 'Peers' });
    // Copy is routed through the lexicon (echoed key 'pot'), not the hardcoded "hive".
    expect(within(peers).getByText(/No pot memberships resolved/i)).toBeTruthy();
  });

  it('renders grant-read unavailability instead of an empty capability matrix', () => {
    h.devices = [identityRow, { kind: 'missing', potHomeSlug: 'papercusp' }];
    h.grants = [unavailable('peer_grants unavailable', 'pre-migration')];
    render(<P2pSettingsPage />);
    const peers = screen.getByRole('region', { name: 'Peers' });
    expect(within(peers).getByRole('alert').textContent).toMatch(/peer_grants unavailable/i);
    expect(within(peers).queryByText(/No capability grants/i)).toBeNull();
  });

  // Endgame D-089 (WI-10004098): v1 peer authority is seat delegation + trust list. checkP2pCapability
  // is on no production path, so no copy may say or imply that a capability grant gates foreign work.
  it('does not claim capability grants gate foreign work in v1', () => {
    render(<P2pSettingsPage />);
    const intro = document.querySelector('.pc-settings-intro');
    expect(intro, 'intro paragraph missing').toBeTruthy();
    expect(intro!.textContent).not.toMatch(/requires BOTH a capability grant/i);
    expect(intro!.textContent).toMatch(/Capability grants .* are recorded but not yet enforced/i);
    const peers = screen.getByRole('region', { name: 'Peers' });
    expect(within(peers).getByText('not enforced in v1')).toBeTruthy();
    expect(peers.textContent).toMatch(/v1 authorization is\s+seat delegation plus your trust list/i);
    const mode = screen.getByRole('combobox', { name: 'Work opt-in mode' });
    expect(within(mode).getByRole('option', { name: 'Any fleet' })).toBeTruthy();
    expect(within(mode).queryByRole('option', { name: /granted/i })).toBeNull();
  });

  it('links shipped budgets to Resources and renders a truthful foreign-work empty state', () => {
    render(<P2pSettingsPage />);
    const live = screen.getByRole('region', { name: 'Foreign work running now' });
    expect(within(live).getByText(/No foreign work is registered on this host/i)).toBeTruthy();
    const budgets = screen.getByRole('region', { name: 'Budgets' });
    const resources = within(budgets).getByRole('link', { name: /Manage allotments in Resources/i });
    expect(resources.getAttribute('href')).toBe('/res');
    expect(budgets.textContent).not.toMatch(/lands? with Phase 2/i);
    expect(live.textContent).not.toMatch(/lands? with Phase 1/i);
  });

  it('renders non-reaped host-local foreign work with lifecycle identity and status', () => {
    h.foreignWorkspaces = [
      {
        workspaceId: 'ws1',
        offerId: 'offer-live',
        fleetSlug: 'fleet-east',
        sessionId: 'session-7',
        state: 'active',
        parkReason: null,
        updatedAt: 1_700_000_000_000,
      },
      {
        workspaceId: 'ws1',
        offerId: 'offer-finished',
        fleetSlug: 'fleet-old',
        sessionId: null,
        state: 'reaped',
        parkReason: null,
        updatedAt: 1_699_000_000_000,
      },
    ];
    render(<P2pSettingsPage />);
    const live = screen.getByRole('region', { name: 'Foreign work running now' });
    expect(within(live).getByText('active')).toBeTruthy();
    expect(within(live).getByText('fleet-east')).toBeTruthy();
    expect(within(live).getByText('offer-live')).toBeTruthy();
    expect(within(live).getByText('session-7')).toBeTruthy();
    expect(within(live).queryByText('offer-finished')).toBeNull();
  });

  it('shows loading and exposes a retry action on foreign-work registry failure', () => {
    h.foreignWorkspaces = undefined;
    h.loadings['p2p.foreignWorkspaces'] = true;
    render(<P2pSettingsPage />);
    expect(screen.getByText(/Loading foreign work/i)).toBeTruthy();
    cleanup();

    h.loadings = {};
    h.errors['p2p.foreignWorkspaces'] = new Error('registry unavailable');
    render(<P2pSettingsPage />);
    const live = screen.getByRole('region', { name: 'Foreign work running now' });
    expect(within(live).getByRole('alert').textContent).toMatch(/registry unavailable/i);
    fireEvent.click(within(live).getByRole('button', { name: /Retry/i }));
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it('renders the audit empty state, then a populated row', () => {
    render(<P2pSettingsPage />);
    const audit = () => screen.getByRole('region', { name: 'P2P audit trail' });
    expect(within(audit()).getByText(/No P2P audit events yet/i)).toBeTruthy();
    cleanup();
    h.audit = [
      { id: 'a1', ts: 1_700_000_000_000, actor: 'owner', action: 'p2p:kill-switch', subject: 'host', details: { engage: true } },
    ];
    render(<P2pSettingsPage />);
    const populated = screen.getByRole('region', { name: 'P2P audit trail' });
    expect(within(populated).getByText('p2p:kill-switch')).toBeTruthy();
    expect(within(populated).getByText('owner')).toBeTruthy();
  });

  it('renders audit-read unavailability instead of the empty-history claim', () => {
    h.audit = [unavailable('audit_log unavailable')];
    render(<P2pSettingsPage />);
    const audit = screen.getByRole('region', { name: 'P2P audit trail' });
    expect(within(audit).getByRole('alert').textContent).toMatch(/audit_log unavailable/i);
    expect(within(audit).queryByText(/No P2P audit events yet/i)).toBeNull();
  });

  it('surfaces a settings load error as an alert (never a silent blank)', () => {
    h.settings = undefined;
    h.errors['p2p.settings'] = new Error('resolver down');
    render(<P2pSettingsPage />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((a) => /Couldn.t load P2P settings/i.test(a.textContent ?? ''))).toBe(true);
  });
});
