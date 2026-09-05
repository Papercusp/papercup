'use client';

/**
 * The operator's Settings as ONE mountable component: `SettingsLayout` around
 * the sub-page the current pathname selects (portal-parity D-009 / P-005,
 * WI-2143414).
 *
 * In the operator this composition is the router's job (`routes/settings.tsx`
 * renders `<SettingsLayout><Outlet/></SettingsLayout>` and each
 * `routes/settings/<sub>.tsx` supplies the outlet). A host without that router
 * — the web portal, mounting operator surfaces natively — gets the same tree
 * from this component: the layout reads `usePathname()` exactly as it does in
 * the operator, and the host's router-compat shim supplies a virtual
 * `/settings/<sub>` pathname (and maps the layout's `RouteLink`s /
 * `router.push` back), so the nav, the highlight and the page all agree.
 */
import { Suspense } from 'react';
import { usePathname } from '@/lib/router-compat/navigation';
import SettingsLayout from './layout';
import { SETTINGS_SURFACE_PAGES, settingsSubPathFor } from './settings-surface-pages';

export default function SettingsSurface() {
  const pathname = usePathname();
  const sub = settingsSubPathFor(pathname);
  const Page = sub ? SETTINGS_SURFACE_PAGES[sub] : null;
  return (
    <SettingsLayout>
      {Page ? (
        <Suspense fallback={null}>
          <Page />
        </Suspense>
      ) : (
        // An operator settings route this table does not mount. The layout
        // (and its nav) still renders, so the reader is one click from a page
        // that does — this only replaces the outlet, never the chrome.
        <p role="status" style={{ color: 'var(--fg-mute)' }}>
          There is no settings page at <code>{pathname}</code> here.
        </p>
      )}
    </SettingsLayout>
  );
}
