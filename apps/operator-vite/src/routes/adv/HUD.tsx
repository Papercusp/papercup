import { createFileRoute } from '@tanstack/react-router';
import AdvShell from '../../components/adv/AdvShell';
import AdvTabErrorBoundary from '../../components/adv/AdvTabErrorBoundary';
import HudView from '@/app/adv/hud/HudView';

/**
 * /adv/HUD — the session HUD (adv-hud-fleet-board-2026-07-25 P-004).
 *
 * A REAL route, not a redirect into the /adv tab shell like its `adv/*`
 * siblings: the owner asked for "a new route /adv/HUD" (2026-07-25), and the
 * board is a destination you keep open rather than a tab you pass through.
 *
 * It still renders inside <AdvShell> so the operator chrome (agents pill, nav)
 * is unchanged, and inside the same per-tab error boundary the /adv tabs use —
 * a render crash here must not white-screen the operator.
 *
 * Casing is deliberate: TanStack file routes are case-sensitive, so this file
 * must stay `HUD.tsx` for the requested `/adv/HUD` URL to resolve.
 */
export const Route = createFileRoute('/adv/HUD')({
  component: HudPage,
});

function HudPage() {
  return (
    <AdvShell title="HUD">
      <AdvTabErrorBoundary tab="hud">
        <HudView />
      </AdvTabErrorBoundary>
    </AdvShell>
  );
}
