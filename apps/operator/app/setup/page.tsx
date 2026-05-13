import { redirect } from 'next/navigation';
import { readOperatorState } from '@/lib/operator-state-pg';
import Chromeless from '../_components/Chromeless';
import { SetupWizard } from '../_components/SetupWizard/SetupWizard';

export const metadata = {
  title: 'Setup · Papercusp',
};

interface PageProps {
  searchParams: Promise<{ force?: string; step?: string }>;
}

/**
 * First-run setup wizard.
 *
 *   - If the wizard has already been finished AND no `?force=1` (and
 *     no specific `?step=...` to revisit), bounce to `/harness` — once
 *     setup is done the user shouldn't keep landing here.
 *   - `/settings/setup-wizard` is the proper "revisit" entry point; it
 *     keeps the operator chrome and never bounces.
 */
export default async function SetupPage({ searchParams }: PageProps) {
  const { force, step } = await searchParams;
  if (force !== '1' && !step) {
    const state = await readOperatorState<{ finished_at?: string }>('setup_wizard_state');
    if (state?.finished_at) redirect('/harness');
  }
  return (
    <div className="pc-shell pc-setup-shell">
      <Chromeless />
      <SetupWizard mode="first-run" />
    </div>
  );
}
