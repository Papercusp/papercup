import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../../lib/require-flag';
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
 * The `requireFlag(FLAGS.SNAPSHOTS)` gate is ported to a TSR `beforeLoad`
 * check — see `lib/require-flag.ts`.
 */
export const Route = createFileRoute('/snapshots/$id/fork')({
  beforeLoad: () => requireFlag(FLAGS.SNAPSHOTS),
  component: SnapshotFork,
});

function SnapshotFork() {
  const { id } = Route.useParams();
  return <ForkClient params={Promise.resolve({ id })} />;
}
