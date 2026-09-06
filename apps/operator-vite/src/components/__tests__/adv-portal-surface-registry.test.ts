/**
 * Every desktop ADV tab reaches the cloud portal (portal-parity-adv-tabs-2026-09-05 P-001).
 *
 * The portal mounts an ADV tab's body natively through
 * `packages/operator-ui/src/surfaces` `OPERATOR_SURFACES[kind]`, so a desktop tab
 * is reachable in the portal ONLY when that registry names it. Before this plan
 * 14 of the 20 tabs were silently absent (the portal collapsed them to Overview).
 * `ADV_TAB_SURFACE_KINDS` is typed over the full `AdvTabId` union, which makes
 * the omission a compile error; this test pins the RUNTIME half — that each
 * mapped kind really has a component behind it, that the map is a bijection, and
 * that the pot-bar verdict for a surface is the operator's own verdict for its tab.
 */
import { describe, expect, it, vi } from 'vitest';

// The bridge writes the grid palette into the document at import; a registry
// test has no document to paint (same mock the PlansSurface test uses).
vi.mock('../../../../../packages/operator-ui/src/grid-theme-bridge', () => ({}));

import { ADV_TAB_IDS } from '../adv/AdvShell';
import { POT_BAR_TAB_IDS, potBarModeForTab } from '../adv/adv-pot-bar-tabs';
import {
  ADV_TAB_SURFACE_KINDS,
  OPERATOR_SURFACES,
  advTabForSurface,
  isOperatorSurfaceKind,
  potScopeForSurface,
} from '../../../../../packages/operator-ui/src/surfaces';

describe('portal surface registry covers every ADV tab', () => {
  it('maps every ADV_TAB_IDS entry to a registered operator surface', () => {
    expect(ADV_TAB_IDS.length).toBe(20);
    for (const tab of ADV_TAB_IDS) {
      const kind = ADV_TAB_SURFACE_KINDS[tab];
      expect(kind, `ADV tab "${tab}" has no portal surface kind`).toBeTruthy();
      expect(isOperatorSurfaceKind(kind), `kind "${kind}" for tab "${tab}" is not in OPERATOR_SURFACES`).toBe(true);
      expect(OPERATOR_SURFACES[kind]).toBeDefined();
    }
  });

  it('is a bijection: no two tabs share a kind, and every mapped kind resolves back to its tab', () => {
    const kinds = Object.values(ADV_TAB_SURFACE_KINDS);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const tab of ADV_TAB_IDS) {
      expect(advTabForSurface(ADV_TAB_SURFACE_KINDS[tab])).toBe(tab);
    }
  });

  it('renames only the kinds whose ADV id the portal already uses for another surface (D-005 / D-006)', () => {
    expect(ADV_TAB_SURFACE_KINDS.calendar).toBe('scheduled');
    expect(ADV_TAB_SURFACE_KINDS.plans).toBe('create');
    expect(ADV_TAB_SURFACE_KINDS.settings).toBe('adv-settings');
    expect(ADV_TAB_SURFACE_KINDS.harnesses).toBe('work');
    for (const tab of ADV_TAB_IDS) {
      if (tab === 'calendar' || tab === 'plans' || tab === 'settings' || tab === 'harnesses') continue;
      expect(ADV_TAB_SURFACE_KINDS[tab]).toBe(tab);
    }
  });

  it('gives a surface exactly the pot bar the operator gives its tab', () => {
    for (const tab of ADV_TAB_IDS) {
      const kind = ADV_TAB_SURFACE_KINDS[tab];
      expect(potScopeForSurface(kind)).toEqual(
        POT_BAR_TAB_IDS.has(tab) ? potBarModeForTab(tab) : { show: false, withStatus: false },
      );
    }
    // Non-ADV surfaces never get a pot bar; an unknown kind never throws.
    for (const kind of ['plans', 'inbox', 'desktops', 'cloud', 'cupboard', 'dev', 'support', 'settings', 'quick-panel', 'no-such-kind']) {
      expect(potScopeForSurface(kind)).toEqual({ show: false, withStatus: false });
      expect(advTabForSurface(kind)).toBeUndefined();
    }
  });

  /**
   * The desktop's global-shortcut palette (/quick-panel: prompts | brainstorm |
   * docs) reaches the portal as the `quick` shell PANEL, not a rail app
   * (portal-quick-panel-palette-2026-09-06 D-001) — so it is a registered
   * surface with no ADV tab behind it and no pot bar.
   */
  it('registers the quick-panel palette as a non-ADV surface (D-001)', () => {
    expect(isOperatorSurfaceKind('quick-panel')).toBe(true);
    expect(OPERATOR_SURFACES['quick-panel']).toBeDefined();
    expect(Object.values(ADV_TAB_SURFACE_KINDS)).not.toContain('quick-panel');
  });
});
