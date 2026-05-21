import { createFileRoute } from '@tanstack/react-router';
import ForkClient from '@/app/snapshots/[id]/fork/ForkClient';

/**
 * /snapshots/$id/fork — fork-completion UI. Translated from
 * `apps/operator/app/snapshots/[id]/fork/page.tsx`.
 *
 * `ForkClient` was authored for Next 15+ where route props are async:
 * its signature is `{ params: Promise<{ id }> }` and it calls
 * `React.use(params)` to unwrap. Under TSR-SPA params are synchronous,
 * so we wrap with `Promise.resolve()` to preserve the existing component
 * signature (avoids editing the shared component).
 *
 * **Deviation:** requireFlag(FLAGS.SNAPSHOTS) gate dropped — same SPA-flags
 * deferral as `/design/$slug`.
 */
export const Route = createFileRoute('/snapshots/$id/fork')({
  component: SnapshotFork,
});

function SnapshotFork() {
  const { id } = Route.useParams();
  return <ForkClient params={Promise.resolve({ id })} />;
}
