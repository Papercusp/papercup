import { HarnessesView } from '@restart/papercup-shared';
import HarnessDashboard from '../../../papercusp/app/harness/HarnessDashboard';

export const dynamic = 'force-dynamic';

export default function HarnessesPage() {
  return <HarnessesView basePath="/papercup" dashboardSlot={<HarnessDashboard />} />;
}
