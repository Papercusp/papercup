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
 *   - the P-104-gated live foreign-work view + the P-201-gated budgets both
 *     render their explicit "lands with Phase N" pending copy (gating is
 *     structural + visible, not a blank);
 *   - Audit shows the empty state and a populated row;
 *   - a settings load error surfaces an alert (never a silent blank).
 *
 * Seams: @papercusp/sync (useSyncQuery/useSyncMutate) + nuqs + sonner +
 * the Radix-backed harness Select/Checkbox are module-mocked; real drag /
 * Radix pointer mechanics are exercised by the Tauri e2e surface, not jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

/* ── Hoisted mutable holder the sync factory closes over ── */
const h = vi.hoisted(() => ({
  settings: undefined as unknown,
  devices: undefined as unknown,
  audit: undefined as unknown,
  grants: undefined as unknown,
  errors: {} as Record<string, Error | null>,
  lastArgs: {} as Record<string, unknown>,
  mutate: vi.fn(async (_args: unknown) => ({ ok: true })),
}));

vi.mock('@papercusp/sync', () => ({
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
              : undefined;
    return { data, error: h.errors[q.queryName] ?? null, loading: false, fetching: false };
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

beforeEach(() => {
  h.settings = mkLayers();
  h.devices = [];
  h.audit = [];
  h.grants = [];
  h.errors = {};
  h.lastArgs = {};
  h.mutate.mockClear();
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

  it('is LOUD when identity is unresolved (no attested identity)', () => {
    h.devices = []; // no identity row at all
    render(<P2pSettingsPage />);
    expect(screen.getByText(/IDENTITY UNRESOLVED/i)).toBeTruthy();
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

  it('renders the P-104-gated live foreign-work view + P-201-gated budgets as explicit pending copy', () => {
    render(<P2pSettingsPage />);
    const live = screen.getByRole('region', { name: 'Foreign work running now' });
    expect(within(live).getByText(/lands with Phase 1 \(plan item P-104\)/i)).toBeTruthy();
    const budgets = screen.getByRole('region', { name: 'Budgets' });
    expect(within(budgets).getByText(/land with Phase 2 \(plan\s+item P-201\)/i)).toBeTruthy();
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

  it('surfaces a settings load error as an alert (never a silent blank)', () => {
    h.settings = undefined;
    h.errors['p2p.settings'] = new Error('resolver down');
    render(<P2pSettingsPage />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts.some((a) => /Couldn.t load P2P settings/i.test(a.textContent ?? ''))).toBe(true);
  });
});
