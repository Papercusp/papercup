'use client';

/**
 * Discord-parity app-level navigation shortcuts (discord-shortcuts
 * 2026-06-06), mounted once at the app shell:
 *
 *   - Mod+,        → /settings              (Discord: user settings)
 *   - Mod+I        → /adv?tab=conversations (Discord: inbox)
 *   - Mod+Shift+N  → /adv?create=true       (Discord: create/join server →
 *                                            our create-harness wizard)
 *
 * These are the ROOT fallbacks: AdvShell registers its own handlers for
 * `goto.inbox` / `harness.create` (flipping its nuqs state in place), and
 * the shortcut bus runs the most-recently-registered action — so when /adv
 * is mounted its in-place handler wins, and from any other route these
 * navigate there. Renders nothing.
 */
import { useRouter } from '../../lib/router-compat/navigation';
import { useShortcutAction } from '../../lib/hotkeys';

export default function GlobalAppShortcuts() {
  const router = useRouter();

  useShortcutAction('settings.open', () => {
    router.push('/settings');
  });

  useShortcutAction('goto.inbox', () => {
    router.push('/adv?tab=conversations');
  });

  useShortcutAction('harness.create', () => {
    router.push('/adv?create=true');
  });

  return null;
}
