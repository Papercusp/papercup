import { SetupWizard } from '../_components/SetupWizard/SetupWizard';

export const metadata = {
  title: 'Setup · Papercusp',
};

export default function SetupPage() {
  return (
    <div className="pc-shell pc-setup-shell">
      <SetupWizard mode="first-run" />
    </div>
  );
}
