import { createFileRoute } from '@tanstack/react-router';
import Chromeless from '@/app/_components/Chromeless';
import { SetupWizard } from '@/app/_components/SetupWizard/SetupWizard';
import { SetupPreviewPane } from '../components/setup/SetupPreviewPane';

/**
 * /setup — first-run wizard. Translated from `apps/operator/app/setup/page.tsx`.
 *
 * Originally deferred from B-1 because `SetupWizard.tsx` imports `useRouter`
 * from `next/navigation`. The `shims/next-navigation.tsx` alias (`ce187bd5`)
 * now resolves that to a TSR-backed wrapper — no edit to the shared
 * component needed.
 *
 * Deep-link example: `/setup?step=workspace` jumps to the workspace step.
 * Query state is parsed inside `SetupWizard` (nuqs); we don't validateSearch
 * here so the wizard can read any step's params it wants.
 */
export const Route = createFileRoute('/setup')({
  component: SetupPage,
});

function SetupPage() {
  return (
    <div className="pc-shell pc-setup-shell">
      <Chromeless />
      {/* First-run: the wizard is the main mode; a read-only preview of the
          real app (operator + chat, and the pui terminal) rides alongside so
          the user sees what they're setting up. The shared SetupWizard is
          unchanged — the preview is composed here, first-run only (settings
          mode at /settings/setup-wizard renders the wizard without it). */}
      <div className="pc-setup-firstrun">
        <div className="pc-setup-firstrun__main">
          <SetupWizard mode="first-run" />
        </div>
        <SetupPreviewPane />
      </div>
    </div>
  );
}
