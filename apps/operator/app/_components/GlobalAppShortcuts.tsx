'use client';

/**
 * Discord-parity app-level navigation shortcuts (discord-shortcuts
 * 2026-06-06), mounted once at the app shell:
 *
 *   - Mod+,        → /settings              (Discord: user settings)
 *   - Mod+I        → /adv?tab=conversations (Discord: inbox)
 *   - Mod+Shift+N  → /adv?create=true       (Discord: create/join server →
 *                                            our create-harness wizard)
 *   - g then b     → /adv?tab=brainstorm    (Linear-style 2-stroke tab jump)
 *   - g then i     → /adv?tab=insights
 *
 * These are the ROOT fallbacks: AdvShell registers its own handlers for
 * `goto.inbox` / `harness.create` / `goto.brainstorm` / `goto.insights`
 * (flipping its nuqs state in place), and the shortcut bus runs the
 * most-recently-registered action — so when /adv is mounted its in-place
 * handler wins, and from any other route these navigate there. Renders
 * nothing.
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

  // Both tabs are per-pot, so landing here from another route shows AdvShell's
  // pick-a-pot empty-state until a pot is selected — same as any deep link to a
  // per-pot tab. These ids had no handler at all before settings-audit 2026-07-09.
  useShortcutAction('goto.brainstorm', () => {
    router.push('/adv?tab=brainstorm');
  });

  useShortcutAction('goto.insights', () => {
    router.push('/adv?tab=insights');
  });

  return null;
}
