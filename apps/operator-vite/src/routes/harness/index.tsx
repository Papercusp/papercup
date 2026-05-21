import { createFileRoute } from '@tanstack/react-router';
import HarnessDashboard from '@/app/harness/HarnessDashboard';

/**
 * /harness — the operator's main surface. Translated from
 * `apps/operator/app/harness/page.tsx`.
 *
 * The shared component `HarnessDashboard` still imports
 * `useParams`/`useSearchParams`/`dynamic` from `next/*`; under Vite those
 * resolve through `shims/next-navigation.tsx` + `shims/next-dynamic.tsx`
 * to TSR-backed wrappers. No edit to the source needed.
 */
export const Route = createFileRoute('/harness/')({
  component: HarnessPage,
});

function HarnessPage() {
  return <HarnessDashboard />;
}
