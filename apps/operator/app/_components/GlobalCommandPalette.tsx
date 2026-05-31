'use client';

/**
 * App-wide command palette host.
 *
 * Owns the palette's open state and the `palette.toggle` keyboard
 * binding (⌘K / Ctrl+P / ⌘/ — see `lib/shortcut-registry.ts`). Mounted
 * once at the app root (`app/layout.tsx`, inside <NuqsAdapter>), so
 * Ctrl+P opens the palette on EVERY route — not just the harness
 * dashboard, which is where the old handler lived before it was deleted
 * with HarnessDashboard.
 *
 * Open state lives in the URL (`?palette=1`) via nuqs — per the repo's
 * "user-meaningful state goes in the URL" rule it's deep-linkable and
 * agent-driveable (ui:dispatch can open the palette). nuqs defaults to
 * `history: 'replace'`, so toggling the palette does NOT push a history
 * entry — important now that Alt+Left/Right traverse browser history.
 *
 * The palette UI is lazy: its chunk (cmdk + Radix Dialog) only loads the
 * first time the user opens it, keeping it off the first-paint path of
 * every page.
 */
import { lazy, Suspense, useMemo } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useSearchParams } from 'next/navigation';
import { useShortcutAction } from '../../lib/hotkeys';
import { buildRegistryPaletteItems } from '../../lib/commands/shims/palette-shim';
import type { Command } from './CommandPalette';

const CommandPalette = lazy(() => import('./CommandPalette'));

export default function GlobalCommandPalette() {
  const [open, setOpen] = useQueryState('palette', parseAsBoolean.withDefault(false));
  const searchParams = useSearchParams();
  const workspace = searchParams?.get('ws') ?? 'default';

  // Toggle on the registry's `palette.toggle` combo. `enableOnFormTags`
  // matches the registry def so the palette opens even while focus is in
  // a text input (e.g. the operator chat composer or a vditor editor).
  useShortcutAction(
    'palette.toggle',
    () => { void setOpen((o) => !o); },
    { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  );

  // Rows come from the Action Registry — every command tagged with a
  // `paletteEntry` (nav.*, operator.*, panel.*). Memoized by workspace
  // so the perform() closures capture the active ws; cheap to rebuild.
  const commands = useMemo<Command[]>(() => {
    const sessionId = typeof window !== 'undefined'
      ? (window.sessionStorage.getItem('pc-voice-tab-id') ?? undefined)
      : undefined;
    return buildRegistryPaletteItems({ workspace, sessionId }).map((it) => ({
      id: it.id,
      title: it.title,
      section: it.section,
      icon: it.icon,
      keywords: it.keywords,
      perform: it.perform,
    }));
  }, [workspace]);

  // Don't mount the lazy palette chunk until first open.
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette open onClose={() => { void setOpen(false); }} commands={commands} />
    </Suspense>
  );
}
