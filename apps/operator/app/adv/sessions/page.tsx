import 'react-diff-view/style/index.css';
import AdvSessionsClient from './AdvSessionsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Advanced · Sessions · Papercusp' };

// Sessions surface — lists agent terminal sessions launched via the
// /api/agent-mcp/console/launch path with their lifecycle state from
// harness_shared.adv_sessions (migration 079). Active rows surface a
// Focus button (resolves pid → window id via wmctrl); inactive rows
// surface a Resume button (omp --resume <thread-id>) when the
// captured OMP thread id is available.
export default function AdvSessionsPage() {
  return <AdvSessionsClient />;
}
