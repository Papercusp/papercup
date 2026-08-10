// @vitest-environment jsdom
/**
 * Settings nav — per-path FLAG gating (SETTINGS_PATH_FLAGS).
 *
 * `settings-audit-nav.test.ts` next door asserts the nav's plain DATA (which
 * hrefs exist, no duplicates). It imports SETTINGS_GROUPS and never renders, so
 * it cannot see `linkAllowed` — the flag composition lives inside the component.
 * This file covers that half.
 *
 * The case that motivated it (retire-mug-kettle-su-only-2026-08-09 P-011 / D-021):
 * /settings/autonomy must take BOTH gates. `MUG_AUTONOMY_SETTINGS` is the
 * pre-existing per-page kill-switch (ON by default); `MUG_KETTLE_SYSTEM` (DEFAULT
 * OFF) retires the tier the page steers. They answer different questions and both
 * must hold, so dropping either one from the `&&` has to fail here.
 *
 * NOTE ON SCOPE — this gates the NAV ENTRY ONLY. `linkAllowed` filters
 * SETTINGS_GROUPS and nothing else, so the route stays reachable by a typed URL.
 * The page's own early return is what makes it safe; see page.test.tsx's
 * "Mug/Kettle retired" block. Neither half is sufficient alone, which is exactly
 * why both are tested.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FLAGS } from '@papercusp/flags';

/** Per-key so one flag can be flipped without disturbing the others — a blanket
 *  `() => true` / `() => false` mock cannot express "both gates" at all, which is
 *  the entire subject of this file. */
const flagValues: Record<string, boolean> = {};
vi.mock('@/lib/flag-hooks', () => ({
  useFlag: (k: string) => flagValues[k] ?? true,
}));

vi.mock('@/lib/router-compat/navigation', () => ({
  usePathname: () => '/settings/profile',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('../_components/RouteLink', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../harness/Select', () => ({
  Select: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

import SettingsLayout from './layout';

beforeEach(() => {
  for (const k of Object.keys(flagValues)) delete flagValues[k];
  // The wizard-state probe is fire-and-forget and its failure is swallowed by the
  // component; stub it so the test never touches the network.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderNav = () => render(<SettingsLayout>{null}</SettingsLayout>);
const autonomyLink = () =>
  document.querySelector('nav a[href="/settings/autonomy"]');

describe('settings nav — /settings/autonomy takes BOTH gates (P-011 / D-021)', () => {
  it('is listed when both flags are on', () => {
    flagValues[FLAGS.MUG_AUTONOMY_SETTINGS] = true;
    flagValues[FLAGS.MUG_KETTLE_SYSTEM] = true;
    renderNav();
    // SHOW CONTROL for every hide-assertion below: proves the query, the nav and
    // the fixture can produce this link at all. Without it a null is equally
    // satisfied by a nav that failed to render.
    expect(autonomyLink()).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Settings pages' })).toBeTruthy();
  });

  it('is hidden when the Mug/Kettle tier is retired, even with the page flag ON', () => {
    flagValues[FLAGS.MUG_AUTONOMY_SETTINGS] = true;
    flagValues[FLAGS.MUG_KETTLE_SYSTEM] = false;
    renderNav();
    expect(autonomyLink()).toBeNull();
    // CALIBRATION — the rest of the nav must still be there, or the null above
    // would just mean "nothing rendered". Only this one entry is gated.
    expect(document.querySelector('nav a[href="/settings/profile"]')).not.toBeNull();
  });

  it('is hidden by its own page flag, even with the tier ON (the pre-existing gate still works)', () => {
    flagValues[FLAGS.MUG_AUTONOMY_SETTINGS] = false;
    flagValues[FLAGS.MUG_KETTLE_SYSTEM] = true;
    renderNav();
    expect(autonomyLink()).toBeNull();
    expect(document.querySelector('nav a[href="/settings/profile"]')).not.toBeNull();
  });

  it('leaves ungated entries alone when the tier is retired', () => {
    flagValues[FLAGS.MUG_KETTLE_SYSTEM] = false;
    renderNav();
    // The retirement must not leak into unrelated pages — a gate that hides more
    // than its one entry would pass the assertions above for the wrong reason.
    expect(document.querySelector('nav a[href="/settings/profile"]')).not.toBeNull();
    expect(document.querySelector('nav a[href="/settings/api-keys"]')).not.toBeNull();
  });
});
